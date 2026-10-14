import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { rpcSessionSelectionOracle, type SelectionState } from './helpers/rpcSessionSelectionOracle'
import { selectRemoteModel } from '../src/main/agent/engine/rpc/model-selection'

function history(messages: unknown[]): unknown[] {
  return messages.map((value) => {
    const message = value as Record<string, unknown>
    return Object.fromEntries(
      ['role', 'content', 'provider', 'model', 'stopReason']
        .filter((key) => message[key] !== undefined)
        .map((key) => [key, message[key]])
    )
  })
}

test(
  'real RPC model changes journal the effective thinking and fresh resume preserves messages without replay',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionSelectionOracle()
    t.after(() => f.close())
    await f.select(1)
    await f.thinking('high')
    f.base.provider.enqueue({ text: 'retained selection answer' })
    assert.equal((await f.connection.prompt('one explicit prompt')).status, 'completed')
    const before = await f.state(),
      messages = history(await f.messages())
    assert.equal(before.thinkingLevel, 'high')
    assert.equal(before.autoCompactionEnabled, true)
    await f.select(0)
    assert.equal((await f.state()).thinkingLevel, undefined)
    await f.select(1)
    assert.equal(
      (await f.state()).thinkingLevel,
      undefined,
      'switching back does not restore a previous thinking level'
    )
    await f.thinking('off')
    assert.equal(f.base.provider.requests.length, 1, 'selection controls never invoke a model')
    const entries = await f.journal()
    assert.ok(
      entries.some(
        (entry) =>
          entry.type === 'model_change' &&
          entry.model === `${before.model.provider}/${f.metadata.models[0].id}`
      )
    )
    assert.ok(
      entries.some(
        (entry) => entry.type === 'thinking_level_change' && entry.thinkingLevel === null
      )
    )
    assert.equal(
      entries.findLast((entry) => entry.type === 'thinking_level_change')?.thinkingLevel,
      'off'
    )
    assert.deepEqual(history(await f.messages()), messages)
    await f.reopen(before.sessionFile)
    const restored = await f.state()
    assert.equal(restored.sessionId, before.sessionId)
    assert.equal(restored.model.id, f.metadata.models[1].id)
    assert.equal(restored.thinkingLevel, 'off')
    assert.deepEqual(history(await f.messages()), messages)
    assert.equal(f.base.provider.requests.length, 1, 'fresh SDK resume does not replay a prompt')
    f.base.provider.enqueue({ text: 'next explicit answer' })
    assert.equal((await f.connection.prompt('next explicit prompt')).status, 'completed')
    assert.equal(f.base.provider.requests.length, 2)
    assert.equal(f.base.provider.requests[1].model, f.metadata.models[1].id)
  }
)

test(
  'official thinking commands silently clamp unsupported values, so Phi must validate and read back',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionSelectionOracle()
    t.after(() => f.close())
    await f.select(0)
    assert.deepEqual(await f.connection.request({ type: 'get_available_thinking_levels' }), {
      levels: ['off']
    })
    await f.thinking('off')
    assert.equal((await f.state()).thinkingLevel, 'off')
    await f.thinking('high')
    assert.equal((await f.state()).thinkingLevel, undefined)
    await f.select(1)
    assert.deepEqual(await f.connection.request({ type: 'get_available_thinking_levels' }), {
      levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
    })
    await f.thinking('max')
    assert.equal((await f.state()).thinkingLevel, 'xhigh')
    await f.thinking('invalid')
    assert.equal((await f.state()).thinkingLevel, undefined)
    await f.thinking()
    assert.equal((await f.state()).thinkingLevel, undefined)
    assert.equal(f.base.provider.requests.length, 0)
  }
)

test(
  'official raw controls accept changes during streaming; the Phi idle gate must own admission',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionSelectionOracle()
    t.after(() => f.close())
    await f.select(1)
    await f.thinking('high')
    f.base.provider.enqueue({ text: 'held response', hold: true })
    let visible!: () => void
    const seen = new Promise<void>((resolve) => {
      visible = resolve
    })
    const off = f.connection.onEvent((frame) => {
      if (frame.type === 'message_update') visible()
    })
    t.after(off)
    const prompt = f.connection.prompt('hold this explicit request')
    void prompt.catch(() => {})
    await seen
    assert.equal((await f.state()).isStreaming, true)
    await f.thinking('low')
    assert.equal((await f.state()).thinkingLevel, 'low')
    await f.connection.request({
      type: 'set_model',
      provider: f.metadata.models[0].provider,
      modelId: f.metadata.models[0].id
    })
    const changed = await f.state()
    assert.equal(changed.isStreaming, true)
    assert.equal(changed.model.id, f.metadata.models[0].id)
    assert.equal(changed.thinkingLevel, undefined)
    await f.connection.abort()
    assert.equal((await prompt).status, 'aborted')
    assert.equal(
      f.base.provider.requests.length,
      1,
      'raw control/stop does not replay the accepted request'
    )
  }
)

test(
  'invalid models preserve selection; disconnect recovery reads the journal instead of replaying model work',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionSelectionOracle()
    t.after(() => f.close())
    await f.select(1)
    await f.thinking('high')
    f.base.provider.enqueue({ text: 'before disconnect' })
    await f.connection.prompt('retained user turn')
    const before = await f.state(),
      messages = history(await f.messages())
    await assert.rejects(
      f.connection.request({
        type: 'set_model',
        provider: before.model.provider,
        modelId: 'missing-model'
      }),
      /Model not found/
    )
    assert.equal((await f.state()).model.id, before.model.id)
    assert.equal((await f.state()).thinkingLevel, 'high')
    const pending = f.thinking('low')
    void pending.catch(() => {})
    f.disconnect()
    await Promise.allSettled([pending])
    const journal = (await readFile(before.sessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const persisted = journal.findLast(
      (entry) => entry.type === 'thinking_level_change'
    )?.thinkingLevel
    await f.reopen(before.sessionFile)
    const restored: SelectionState = await f.state()
    assert.equal(restored.thinkingLevel, persisted ?? undefined)
    assert.equal(restored.model.id, before.model.id)
    assert.deepEqual(history(await f.messages()), messages)
    assert.equal(f.base.provider.requests.length, 1)
  }
)

test(
  'public SDK registry refresh cannot expand the fixed trusted Phi model generation',
  { timeout: 30000 },
  async (t) => {
    const f = await rpcSessionSelectionOracle()
    t.after(() => f.close())
    await f.select(1)
    const before = await f.state()
    const path = join(f.base.agentDir, 'models.yml')
    const config = JSON.parse(await readFile(path, 'utf8'))
    config.providers[f.candidate.provider].models.push(f.candidate)
    await writeFile(path, JSON.stringify(config), { mode: 0o600 })
    const enlarged = { ...f.metadata, models: [...f.metadata.models, f.candidate] }
    await writeFile(f.base.metadataPath, JSON.stringify(enlarged), { mode: 0o600 })
    await f.refresh()
    const available = await f.connection.request<{ models: Array<{ id: string }> }>({
      type: 'get_available_models'
    })
    assert.ok(available.models.some((model) => model.id === f.candidate.id))
    await assert.rejects(
      selectRemoteModel(f.connection, enlarged, f.candidate, new AbortController().signal)
    )
    assert.equal(
      (await f.state()).model.id,
      before.model.id,
      'disk refresh does not replace the extension generation snapshot'
    )
    await f.connection.request({
      type: 'set_model',
      provider: f.candidate.provider,
      modelId: f.candidate.id
    })
    assert.equal(
      (await f.state()).model.id,
      f.candidate.id,
      'the model really is registered in the public SDK registry'
    )
    assert.equal(f.base.provider.requests.length, 0)
  }
)
