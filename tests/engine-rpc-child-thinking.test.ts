import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { childAuthorityCli, childUntil } from './helpers/rpcChildAuthorityCli'

test('actual reasoning model preserves supported high effort through the guarded stream and provider', async () => {
  let release!: (value: 'approved') => void
  const fixture = await childAuthorityCli({
    reasoning: true,
    thinkingLevel: 'high',
    decision: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })
  try {
    const rootLevels = await fixture.connection.request<{ levels: string[] }>({
      type: 'get_available_thinking_levels'
    })
    assert.ok(
      rootLevels.levels.includes('high'),
      'Actual SDK model must advertise high before testing it'
    )
    const commands = await fixture.connection.request<{
      commands: Array<{ name: string; source: string }>
    }>({ type: 'get_available_commands' })
    assert.equal(
      commands.commands.filter(
        (command) =>
          command.name === 'phi-child-server-thinking-probe' && command.source === 'extension'
      ).length,
      1
    )
    const parent = fixture.connection.prompt('Run the trusted high-thinking native child')
    void parent.catch(() => undefined)
    await childUntil(
      () => fixture.approvals.length === 1,
      'high-thinking native child pending approval'
    )
    await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
    assert.equal(
      (await fixture.connection.prompt('/phi-child-server-thinking-probe authority-child'))
        .agentInvoked,
      false
    )
    const probe = fixture.frames
      .filter((frame) => frame.type === 'extension_ui_request' && typeof frame.message === 'string')
      .map((frame) => {
        try {
          return JSON.parse(String(frame.message)) as Record<string, unknown>
        } catch {
          return {}
        }
      })
      .find((value) => value.type === 'phi_child_thinking_probe')
    assert.ok(probe)
    assert.equal(probe.childId, 'authority-child')
    assert.ok(Array.isArray(probe.levels) && probe.levels.includes('high'))
    assert.equal(probe.thinkingLevel, 'high')
    assert.equal(probe.reasoning, 'high')
    assert.ok(probe.disableReasoning === false || probe.disableReasoning === null)
    assert.deepEqual(probe.model, {
      provider: 'fixture',
      id: 'model',
      reasoning: true,
      input: ['text'],
      contextWindow: 32768,
      maxTokens: 1024
    })
    release('approved')
    await parent
    assert.equal(
      await readFile(join(fixture.cwd, 'native-effect.txt'), 'utf8'),
      'REAL_PRODUCTION_CHILD_WRITE\n'
    )
    const childRequests = fixture.requests.filter((request) => request.actor === 'child')
    assert.equal(childRequests.length, 2)
    assert.ok(childRequests.every((request) => request.body.reasoning_effort === 'high'))
  } finally {
    await fixture.close()
  }
})
test('trusted nonreasoning child configuration refuses explicit high before native/provider setup', async () => {
  await assert.rejects(
    childAuthorityCli({ reasoning: false, thinkingLevel: 'high' }),
    /RPC agent thinking level is unsupported by its selected model/
  )
})
