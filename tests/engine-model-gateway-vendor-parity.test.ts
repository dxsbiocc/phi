import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startVendorFixture, type VendorTurn } from './helpers/model-gateway-vendor-fixture'
import { VENDOR_SECRETS as secrets, type VendorKind } from './helpers/model-gateway-vendor-provider'

const initial = {
  systemPrompt: ['Inspect ordinary fixture data.'],
  messages: [{ role: 'user', content: 'Inspect ordinary.txt', timestamp: 1 }],
  tools: [
    {
      name: 'inspect',
      description: 'Inspect ordinary data',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    }
  ]
}
function canonical(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value }
  // Wall-clock latency naturally differs across the two physical transports.
  delete result.timestamp
  delete result.duration
  delete result.ttft
  return result
}
function vendorBody(value: Record<string, unknown>, kind: VendorKind): Record<string, unknown> {
  if (kind !== 'codex') return value
  const result = structuredClone(value)
  const metadata = result.client_metadata as Record<string, unknown>
  // Independent SDK provider-state stores create separate transport turn IDs.
  // Validate their shape and shared lease/session binding without comparing UUIDs.
  for (const key of ['thread_id', 'turn_id', 'x-codex-window-id']) {
    assert.match(String(metadata[key]), /^[0-9a-f-]{36}$/)
    metadata[key] = '<independent-sdk-id>'
  }
  const turn = JSON.parse(String(metadata['x-codex-turn-metadata'])) as Record<string, unknown>
  for (const key of ['thread_id', 'turn_id', 'window_id']) {
    assert.match(String(turn[key]), /^[0-9a-f-]{36}$/)
    turn[key] = '<independent-sdk-id>'
  }
  assert.equal(turn.session_id, metadata.session_id)
  metadata['x-codex-turn-metadata'] = turn
  return result
}
function followup(turn: VendorTurn): unknown {
  const content = turn.message.content as Array<Record<string, unknown>>
  const call = content.find((block) => block.type === 'toolCall')
  assert.ok(call, JSON.stringify(turn.message))
  return {
    ...initial,
    messages: [
      ...initial.messages,
      turn.message,
      {
        role: 'toolResult',
        toolName: 'inspect',
        toolCallId: call.id,
        content: [{ type: 'text', text: 'ordinary fixture result' }],
        isError: false,
        timestamp: 2
      },
      { role: 'user', content: 'Continue with the result', timestamp: 3 }
    ]
  }
}
function assertNativePrivacy(
  snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof startVendorFixture>>['snapshot']>>
): void {
  assert.ok(snapshot.wire.length > 0)
  for (const wire of snapshot.wire) {
    assert.equal(wire.credentialInBody, false)
    assert.equal(wire.credentialInHeader, false)
    assert.equal(wire.rawErrorLeak, false)
    assert.equal(wire.responseHeaders['x-private-vendor'], undefined)
    assert.equal(wire.responseHeaders['x-litellm-model-api-base'], undefined)
  }
  assert.equal(snapshot.debugEnabled, false)
  assert.equal(snapshot.logLeaks, false)
  assert.equal(snapshot.logFiles, 0)
}
for (const kind of ['anthropicKey', 'anthropicOAuth', 'responses', 'codex'] as const) {
  test(
    `real ${kind} SDK preserves native text/thinking/tools and second-turn replay against direct SDK`,
    { timeout: 30000 },
    async (t) => {
      const f = await startVendorFixture()
      t.after(() => f.close())
      const lease = await f.create(kind)
      f.enqueue({ tool: true }, { tool: true })
      const direct = await f.turn(kind, false, initial)
      const native = await f.turn(kind, true, initial)
      assert.equal(direct.message.stopReason, 'toolUse', JSON.stringify(direct))
      assert.equal(native.message.stopReason, 'toolUse', JSON.stringify(native))
      if (kind.startsWith('anthropic'))
        assert.equal(
          (await f.snapshot()).wire.at(-1)?.redactedOnWire,
          true,
          'Desktop gateway must retain redacted thinking before the native SDK client consumes it'
        )
      assert.deepEqual(canonical(native.message), canonical(direct.message))
      const content = native.message.content as Array<Record<string, unknown>>
      assert.ok(
        content.some((block) => block.type === 'text' && block.text === 'Vendor text 中文🙂')
      )
      assert.ok(
        content.some(
          (block) => block.type === 'thinking' && String(block.thinking).includes('Inspect')
        )
      )
      assert.ok(
        content.some(
          (block) =>
            block.type === 'toolCall' &&
            block.name === 'inspect' &&
            JSON.stringify(block.arguments) === '{"path":"ordinary.txt"}'
        )
      )
      if (kind.startsWith('anthropic')) {
        assert.ok(
          content.some(
            (block) => block.type === 'thinking' && block.thinkingSignature === secrets.thinking
          )
        )
        assert.ok(
          content.some(
            (block) => block.type === 'redactedThinking' && block.data === secrets.redacted
          )
        )
      } else
        assert.ok(
          JSON.stringify(native.message).includes(secrets.encrypted),
          'Encrypted native replay metadata must survive'
        )
      f.enqueue({ text: 'Followup preserved' }, { text: 'Followup preserved' })
      const a = await f.turn(kind, false, followup(direct))
      const b = await f.turn(kind, true, followup(native))
      assert.equal(a.message.stopReason, 'stop', JSON.stringify(a))
      assert.deepEqual(canonical(b.message), canonical(a.message))
      const requests = f.provider.requests
      assert.equal(requests.length, 4)
      assert.deepEqual(vendorBody(requests[1].body, kind), vendorBody(requests[0].body, kind))
      assert.deepEqual(vendorBody(requests[3].body, kind), vendorBody(requests[2].body, kind))
      const replay = JSON.stringify(requests[3].body)
      assert.ok(replay.includes('ordinary fixture result'))
      assert.ok(
        replay.includes(kind.startsWith('anthropic') ? secrets.thinking : secrets.encrypted)
      )
      assert.ok(replay.includes('call_parity'))
      for (const request of requests) {
        if (kind === 'anthropicKey') {
          assert.equal(request.headers['x-api-key'], secrets.key)
          assert.equal(request.headers.authorization, undefined)
        } else if (kind === 'anthropicOAuth') {
          assert.equal(request.headers.authorization, `Bearer ${secrets.oauth}`)
          assert.equal(request.headers['x-api-key'], undefined)
          assert.match(String(request.headers['anthropic-beta']), /oauth/)
        } else if (kind === 'responses') {
          assert.equal(request.headers.authorization, `Bearer ${secrets.key}`)
          assert.match(request.path, /\/responses$/)
        } else {
          assert.equal(request.headers['chatgpt-account-id'], 'synthetic-codex-account')
          assert.match(String(request.headers.authorization), /^Bearer eyJ/)
          const payload = JSON.parse(
            Buffer.from(String(request.headers.authorization).split('.')[1], 'base64url').toString()
          ) as { 'https://api.openai.com/auth': { chatgpt_account_id: string } }
          assert.equal(
            payload['https://api.openai.com/auth'].chatgpt_account_id,
            'synthetic-codex-account'
          )
          assert.equal(request.headers.session_id, lease.leaseId)
          assert.equal(request.headers.conversation_id, lease.leaseId)
          assert.equal(request.headers.accept, 'text/event-stream')
          assert.equal(request.body.store, false)
        }
      }
      const snapshot = await f.snapshot()
      assertNativePrivacy(snapshot)
      if (kind.startsWith('anthropic')) assert.equal(snapshot.redirectedOrigins.length, 4)
      assert.equal(snapshot.websocketEnv, '1')
      assert.equal(snapshot.originalCodexPreference, true)
      assert.equal(f.provider.upgrades(), 0)
      assert.equal(f.stderr(), '')
    }
  )
}

test(
  'real Anthropic OAuth 401 refresh retries the same native request without exposing identity credentials',
  { timeout: 30000 },
  async (t) => {
    const f = await startVendorFixture()
    t.after(() => f.close())
    await f.create('anthropicOAuth')
    f.enqueue({ status: 401 }, { text: 'Recovered after refresh' })
    const turn = await f.turn('anthropicOAuth', true, initial)
    assert.equal(turn.message.stopReason, 'stop', JSON.stringify(turn))
    assert.ok(JSON.stringify(turn.message.content).includes('Recovered after refresh'))
    const snapshot = await f.snapshot()
    assert.equal(snapshot.refreshes, 1)
    assert.equal(f.provider.requests.length, 2)
    assert.equal(f.provider.requests[0].headers.authorization, `Bearer ${secrets.oauth}`)
    assert.equal(f.provider.requests[1].headers.authorization, `Bearer ${secrets.oauth}-1`)
    assert.deepEqual(f.provider.requests[1].body, f.provider.requests[0].body)
    assertNativePrivacy(snapshot)
    assert.equal(f.stderr(), '')
  }
)

for (const kind of ['responses', 'codex'] satisfies VendorKind[]) {
  test(
    `real ${kind} native client abort after visible output closes upstream and allows the next turn`,
    { timeout: 30000 },
    async (t) => {
      const f = await startVendorFixture()
      t.after(() => f.close())
      await f.create(kind)
      f.enqueue({ hold: true })
      const canceled = await f.turn(kind, true, initial, true)
      assert.equal(canceled.cancellation, true)
      assert.ok(canceled.events.some((event) => event.type === 'text_delta'))
      const deadline = Date.now() + 500
      let snapshot = await f.snapshot()
      while ((f.provider.active() || snapshot.gateway.activeRequests) && Date.now() < deadline) {
        await delay(10)
        snapshot = await f.snapshot()
      }
      assert.equal(f.provider.active(), 0)
      assert.equal(snapshot.gateway.activeRequests, 0)
      f.enqueue({ text: 'After abort' })
      const next = await f.turn(kind, true, initial)
      assert.equal(next.message.stopReason, 'stop', JSON.stringify(next))
      assert.ok(JSON.stringify(next.message.content).includes('After abort'))
      assert.equal(f.provider.requests.length, 2, 'No replay of canceled output')
      assertNativePrivacy(await f.snapshot())
      assert.equal(f.provider.upgrades(), 0)
      assert.equal(f.stderr(), '')
    }
  )
}

for (const kind of ['anthropicKey', 'responses', 'codex'] as const) {
  test(
    `real ${kind} provider failure hides vendor diagnostics and credentials from native client`,
    { timeout: 30000 },
    async (t) => {
      const f = await startVendorFixture()
      t.after(() => f.close())
      await f.create(kind)
      f.enqueue({ status: 400 })
      const turn = await f.turn(kind, true, initial)
      assert.equal(turn.message.stopReason, 'error', JSON.stringify(turn))
      const output = JSON.stringify(turn)
      for (const secret of [
        secrets.key,
        secrets.oauth,
        secrets.refresh,
        secrets.error,
        f.provider.url
      ])
        assert.equal(output.includes(secret), false)
      assert.equal(turn.message.errorMessage, 'Model request failed')
      assertNativePrivacy(await f.snapshot())
      assert.equal(f.provider.requests.length, 1)
      assert.equal(f.stderr(), '')
    }
  )
}

for (const kind of ['anthropicKey', 'anthropicOAuth'] as const) {
  test(
    `real ${kind} native requests retain signed/redacted inbound tool history and auth shaping`,
    { timeout: 30000 },
    async (t) => {
      const f = await startVendorFixture()
      t.after(() => f.close())
      const lease = await f.create(kind)
      f.enqueue({ tool: true })
      const first = await f.turn(kind, false, initial)
      const context = followup(first)
      f.enqueue({ text: 'Authenticated followup' }, { text: 'Authenticated followup' })
      await f.turn(kind, false, context)
      const next = await f.turn(kind, true, context)
      assert.equal(next.message.stopReason, 'stop')
      assert.ok(JSON.stringify(next.message.content).includes('Authenticated followup'))
      const requests = f.provider.requests
      assert.equal(requests.length, 3)
      assert.deepEqual(requests[2].body, requests[1].body)
      const history = JSON.stringify(requests[2].body.messages)
      for (const marker of [
        secrets.thinking,
        secrets.redacted,
        'ordinary fixture result',
        'call_parity'
      ])
        assert.ok(history.includes(marker), marker)
      for (const request of requests) {
        if (kind === 'anthropicKey') {
          assert.equal(request.headers['x-api-key'], secrets.key)
          assert.equal(request.headers.authorization, undefined)
        } else {
          assert.equal(request.headers.authorization, `Bearer ${secrets.oauth}`)
          assert.equal(request.headers['x-api-key'], undefined)
          assert.match(String(request.headers['anthropic-beta']), /oauth/)
          assert.equal(request.headers['x-claude-code-session-id'], lease.leaseId)
          const metadata = request.body.metadata as { user_id: string }
          const identity = JSON.parse(metadata.user_id) as { session_id: string; device_id: string }
          assert.equal(identity.session_id, lease.leaseId)
          assert.match(identity.device_id, /^[0-9a-f]{64}$/)
        }
      }
      const snapshot = await f.snapshot()
      assert.equal(snapshot.wire.at(-1)?.redactedOnWire, true)
      assert.equal(snapshot.redirectedOrigins.length, 3)
      assertNativePrivacy(snapshot)
      assert.equal(f.stderr(), '')
    }
  )
}
