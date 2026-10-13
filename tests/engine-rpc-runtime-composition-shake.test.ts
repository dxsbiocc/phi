import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PhiTool } from '../src/main/agent/engine/types'
import { SessionVerificationError } from '../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

test(
  'default SDK shake keeps a real recovery artifact across production fresh attach and refuses a missing artifact before provider execution',
  { timeout: 65_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    const original = Array.from({ length: 360_000 }, (_, index) =>
      String.fromCodePoint(0x4e00 + (index % 20000))
    ).join('')
    const tool: PhiTool = {
      name: 'desktop_shake',
      site: 'host',
      approval: 'read',
      label: 'Private shake evidence',
      description: 'Return real context-pressure evidence',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: [{ type: 'text', text: original }] }
      }
    }
    const first = await f.create({ tools: [tool] })
    await f.sdk.enqueue(
      { tool: { name: tool.name, args: {}, id: 'shake-call' } },
      { text: 'shaken result accepted' },
      // Default maintenance may ask the real selected model before falling
      // through to mechanical shake. A missing scripted reply is a fixture500,
      // not a reason to disable that policy or relax the prompt deadline.
      ...Array.from({ length: 12 }, () => ({ text: 'Private maintenance response' }))
    )
    const events: string[] = []
    first.onEvent((frame) => {
      if (frame.type.includes('compact') || frame.type.includes('error')) events.push(frame.type)
    })
    const turn = await first
      .prompt('phi-shake-run', 'Call the host tool under default context pressure')
      .catch(async (error) => {
        throw new Error(
          JSON.stringify({
            failure: error instanceof Error ? error.message : 'unknown',
            events,
            requests: (await f.sdk.snapshot()).providerRequests.length
          }),
          { cause: error }
        )
      })
    assert.equal(turn.outcome, 'completed')
    const result = turn.snapshot.messages.findLast(
      (value) => (value as { role?: string }).role === 'toolResult'
    ) as { prunedAt: number; content: Array<{ text: string }> }
    assert.equal(typeof result.prunedAt, 'number')
    const marker =
      /^\[shaken ~([0-9]+) tokens — recover: artifact:\/\/([0-9]+) \(region ([0-9]+)\)\]$/u.exec(
        result.content[0].text
      )
    assert.ok(marker)
    const artifact = join(
      turn.snapshot.checkpoint.journalPath.slice(0, -'.jsonl'.length),
      marker[2] + '.shake.log'
    )
    assert.ok((await readFile(artifact, 'utf8')).includes(original))
    await first.close()
    const count = (await f.sdk.snapshot()).providerRequests.length
    const second = await f.create({
      tools: [tool],
      action: { type: 'resume', reference: turn.snapshot.reference, savedModel: f.ref }
    })
    assert.equal((await f.sdk.snapshot()).providerRequests.length, count)
    assert.ok(JSON.stringify(second.currentSnapshot().messages).includes(marker[0]))
    await second.close()
    await rm(artifact)
    await assert.rejects(
      f.create({
        tools: [tool],
        action: { type: 'resume', reference: turn.snapshot.reference, savedModel: f.ref }
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof SessionVerificationError &&
        error.cause.code === 'ASSET_MISSING'
    )
    assert.equal((await f.sdk.snapshot()).providerRequests.length, count)
  }
)
