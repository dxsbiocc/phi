import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import { VENDOR_SECRETS } from './helpers/model-gateway-vendor-provider'

test(
  'production entry repairs actual Anthropic opaque/sparse native transport, restores it and returns normal aborted cancellation with a reusable worker',
  { timeout: 75_000 },
  async (t) => {
    const f = await runtimeCompositionFixture({ anthropic: true })
    t.after(() => f.close())
    const first = await f.create()
    await f.sdk.enqueue({ text: 'Signed native response' })
    const turn = await first.prompt('phi-native-integrity-run', 'Preserve signed opaque content')
    assert.equal(turn.outcome, 'completed', turn.result.error?.message)
    const assistant = turn.snapshot.messages.findLast(
      (value) => (value as { role?: string }).role === 'assistant'
    ) as { content: Array<Record<string, unknown>> }
    assert.deepEqual(
      assistant.content.map((block) => block.type),
      ['thinking', 'redactedThinking', 'text']
    )
    assert.equal(assistant.content[0].thinkingSignature, VENDOR_SECRETS.thinking)
    assert.equal(assistant.content[1].data, VENDOR_SECRETS.redacted)
    await first.close()
    const count = (await f.sdk.snapshot()).providerRequests.length
    const second = await f.create({
      action: { type: 'resume', reference: turn.snapshot.reference, savedModel: f.ref }
    })
    assert.equal((await f.sdk.snapshot()).providerRequests.length, count)
    assert.ok(JSON.stringify(second.currentSnapshot().messages).includes(VENDOR_SECRETS.redacted))
    await f.sdk.enqueue({ text: 'Restored opaque native response' })
    assert.equal(
      (await second.prompt('phi-native-restored-run', 'Continue explicitly')).outcome,
      'completed'
    )
    const request = (await f.sdk.snapshot()).providerRequests.at(-1)!.body
    assert.ok(JSON.stringify(request).includes(VENDOR_SECRETS.thinking))
    assert.ok(JSON.stringify(request).includes(VENDOR_SECRETS.redacted))
    await f.sdk.enqueue({ text: 'Partial cancellation evidence', hold: true })
    const held = second.prompt('phi-native-cancel-run', 'Hold until stopped')
    void held.catch(() => undefined)
    const deadline = Date.now() + 8000
    while ((await f.sdk.snapshot()).gateway.activeRequests === 0) {
      if (Date.now() > deadline) throw new Error('Actual native stream did not start')
      await delay(5)
    }
    await delay(30)
    await second.stop()
    const cancelled = await held
    assert.equal(cancelled.result.status, 'aborted')
    assert.equal(cancelled.outcome, 'aborted')
    assert.equal(second.isReady, true)
    assert.equal((await f.sdk.snapshot()).gateway.activeRequests, 0)
    await f.sdk.enqueue({ text: 'Worker reused after native cancellation' })
    assert.equal(
      (await second.prompt('phi-native-next-run', 'Next explicit request')).outcome,
      'completed'
    )
  }
)
