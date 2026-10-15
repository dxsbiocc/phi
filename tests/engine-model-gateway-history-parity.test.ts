import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createModelGatewayCliFixture } from './helpers/model-gateway-cli-fixture'
import { startCloudFixture } from './helpers/model-gateway-cloud-fixture'
import {
  historyAfterTool,
  historyInitial,
  historyMessages,
  statefulHistoryTurn
} from './helpers/model-gateway-history-context'
import {
  startModelGatewaySdkFixture,
  MODEL_GATEWAY_FIXTURE_REFS as sdkRefs
} from './helpers/model-gateway-sdk-fixture'
import { startVendorFixture } from './helpers/model-gateway-vendor-fixture'
import {
  VENDOR_REFS as vendorRefs,
  VENDOR_SECRETS as vendorSecrets
} from './helpers/model-gateway-vendor-provider'

test(
  'official CLI cold history restore retains prior turns across a future provider change without replay',
  { timeout: 60000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture({ oauthExpired: false })
    t.after(() => f.close())
    const lease = await f.create({
      sessionId: 'history-cold-cli',
      generation: 1,
      models: [sdkRefs.key, sdkRefs.none]
    })
    const cli = await createModelGatewayCliFixture(lease)
    t.after(() => cli.close())
    for (const label of ['HISTORY_COLD_FIRST 中文🙂', 'HISTORY_COLD_SECOND αβγ']) {
      await f.enqueue({ text: `${label} answer`, thinking: `${label} reasoning` })
      const result = await cli.connection.prompt(`${label} question`)
      assert.equal(result.status, 'completed')
      assert.equal(result.sessionSettled, true)
    }
    const before = await cli.connection.request<{ messages: Array<Record<string, unknown>> }>({
      type: 'get_messages'
    })
    const original = await cli.connection.request<{ sessionId: string; sessionFile: string }>({
      type: 'get_state'
    })
    assert.equal(typeof original.sessionFile, 'string')
    const physical = await readFile(original.sessionFile, 'utf8')
    for (const label of ['HISTORY_COLD_FIRST', 'HISTORY_COLD_SECOND'])
      assert.ok(physical.includes(label))
    assert.equal((await f.snapshot()).providerRequests.length, 2)

    // Stop/restart the actual CLI while retaining the existing fixture's private
    // HOME and journal. Its public connection factory starts a fresh OS process.
    await cli.connection.close()
    await cli.connection.start()
    const fresh = await cli.connection.request<{ sessionId: string }>({ type: 'get_state' })
    assert.notEqual(fresh.sessionId, original.sessionId)
    const opened = await cli.connection.request<{ cancelled: boolean }>({
      type: 'switch_session',
      sessionPath: original.sessionFile
    })
    assert.equal(opened.cancelled, false)
    await cli.select(sdkRefs.none)
    const restored = await cli.connection.request<{ messages: Array<Record<string, unknown>> }>({
      type: 'get_messages'
    })
    assert.deepEqual(historyMessages(restored.messages), historyMessages(before.messages))
    const state = await cli.connection.request<{
      sessionId: string
      model: { provider: string; id: string }
    }>({ type: 'get_state' })
    assert.equal(state.sessionId, original.sessionId)
    assert.equal(state.model.provider, sdkRefs.none.provider)
    assert.equal(state.model.id, sdkRefs.none.id)
    assert.equal(
      (await f.snapshot()).providerRequests.length,
      2,
      'Cold restore and verified selection cannot replay earlier prompts'
    )
    await f.enqueue({ text: 'HISTORY_COLD_THIRD answer' })
    const result = await cli.connection.prompt('HISTORY_COLD_THIRD question')
    assert.equal(result.status, 'completed')
    const snapshot = await f.snapshot()
    assert.equal(snapshot.providerRequests.length, 3)
    const request = snapshot.providerRequests[2]
    assert.equal(request.body.model, sdkRefs.none.id)
    const sent = JSON.stringify(request.body.messages)
    for (const marker of [
      'HISTORY_COLD_FIRST 中文🙂 question',
      'HISTORY_COLD_FIRST 中文🙂 answer',
      'HISTORY_COLD_SECOND αβγ question',
      'HISTORY_COLD_SECOND αβγ answer',
      'HISTORY_COLD_THIRD question'
    ])
      assert.equal(sent.split(marker).length - 1, 1, marker)
    assert.equal(
      request.headers.authorization,
      undefined,
      'Keyless target retains its actual auth policy after history restore'
    )
    assert.equal(snapshot.debugEnabled, false)
    assert.deepEqual(snapshot.rawLogFiles, [])
    assert.equal(cli.stderr(), '')
    assert.equal(f.stderr(), '')
  }
)

test(
  'Anthropic and Responses migrated signed tool history matches direct SDK and stateful prefix divergence falls back to full replay',
  { timeout: 30000 },
  async (t) => {
    const f = await startVendorFixture()
    t.after(() => f.close())
    await f.create('anthropicKey')
    const responsesLease = await f.create('responses')
    for (const [source, target, opaque] of [
      ['anthropicKey', 'responses', vendorSecrets.thinking],
      ['responses', 'anthropicKey', vendorSecrets.encrypted]
    ] as const) {
      f.enqueue({ tool: true })
      const first = await f.turn(source, true, historyInitial)
      assert.equal(first.message.stopReason, 'toolUse')
      assert.ok(JSON.stringify(first.message).includes(opaque))
      const marker = `HISTORY_MIGRATE_${source}_TO_${target}`
      const history = JSON.parse(JSON.stringify(historyAfterTool(first.message, marker)))
      const offset = f.provider.requests.length
      f.enqueue({ text: marker }, { text: marker })
      const direct = await f.turn(target, false, history)
      const native = await f.turn(target, true, history)
      assert.equal(direct.message.stopReason, 'stop')
      assert.equal(native.message.stopReason, 'stop')
      assert.deepEqual(native.message.content, direct.message.content)
      assert.deepEqual(f.provider.requests[offset + 1].body, f.provider.requests[offset].body)
      const sent = JSON.stringify(f.provider.requests[offset + 1].body)
      assert.ok(sent.includes(marker))
      assert.ok(sent.includes('call_parity'))
      assert.equal(
        sent.includes(opaque),
        false,
        'Foreign signed/opaque provider payload must follow the actual SDK migration rules'
      )
    }

    const offset = f.provider.requests.length
    const a = {
      ...historyInitial,
      messages: [{ role: 'user', content: 'KV_ACTOR_A_INITIAL', timestamp: 1 }]
    }
    const b = {
      ...historyInitial,
      messages: [{ role: 'user', content: 'KV_ACTOR_B_INITIAL', timestamp: 1 }]
    }
    f.enqueue({ tool: true })
    const first = await statefulHistoryTurn(responsesLease, vendorRefs.responses, a)
    const aHistory = historyAfterTool(first, 'KV_ACTOR_A_TOOL_RESULT', a)
    f.enqueue({ text: 'KV_ACTOR_A_SECOND' })
    const second = await statefulHistoryTurn(responsesLease, vendorRefs.responses, aHistory)
    f.enqueue({ text: 'KV_ACTOR_B_FIRST' })
    await statefulHistoryTurn(responsesLease, vendorRefs.responses, b)
    f.enqueue({ text: 'KV_ACTOR_A_THIRD' })
    await statefulHistoryTurn(responsesLease, vendorRefs.responses, {
      ...aHistory,
      messages: [
        ...(aHistory.messages as unknown[]),
        second,
        { role: 'user', content: 'KV_ACTOR_A_CONTINUE', timestamp: 4 }
      ]
    })
    const requests = f.provider.requests.slice(offset)
    assert.equal(requests.length, 4)
    assert.equal(requests[0].body.store, true)
    assert.equal(requests[0].body.previous_response_id, undefined)
    assert.equal(
      requests[1].body.previous_response_id,
      'resp_parity',
      'Supported stateful Responses must actually use the retained chain'
    )
    assert.equal(JSON.stringify(requests[1].body.input).includes('KV_ACTOR_A_INITIAL'), false)
    assert.ok(JSON.stringify(requests[1].body.input).includes('KV_ACTOR_A_TOOL_RESULT'))
    for (const index of [2, 3])
      assert.equal(
        requests[index].body.previous_response_id,
        undefined,
        'Different wire history must reset the retained chain'
      )
    const bInput = JSON.stringify(requests[2].body.input)
    assert.ok(bInput.includes('KV_ACTOR_B_INITIAL'))
    assert.equal(bInput.includes('KV_ACTOR_A_INITIAL'), false)
    assert.equal(bInput.includes('KV_ACTOR_A_TOOL_RESULT'), false)
    assert.ok(JSON.stringify(requests[3].body.input).includes('KV_ACTOR_A_INITIAL'))
    assert.ok(JSON.stringify(requests[3].body.input).includes('KV_ACTOR_A_TOOL_RESULT'))
    assert.ok(JSON.stringify(requests[3].body.input).includes('KV_ACTOR_A_CONTINUE'))
    assert.equal(JSON.stringify(requests[3].body.input).includes('KV_ACTOR_B_INITIAL'), false)
    for (const request of requests)
      assert.equal(request.body.prompt_cache_key, responsesLease.leaseId)
    const snapshot = await f.snapshot()
    assert.equal(snapshot.debugEnabled, false)
    assert.equal(snapshot.logLeaks, false)
    assert.equal(snapshot.logFiles, 0)
    assert.equal(f.stderr(), '')
  }
)

test(
  'Google and Bedrock migrated tool signatures preserve the actual SDK cross-family replay semantics',
  { timeout: 30000 },
  async (t) => {
    const f = await startCloudFixture()
    t.after(() => f.close())
    for (const [source, target] of [
      ['google', 'bedrock'],
      ['bedrock', 'google']
    ] as const) {
      f.provider.enqueue({ tool: true })
      const first = await f.turn(source, true, historyInitial)
      assert.equal(first.message.stopReason, 'toolUse', first.message.errorMessage)
      const marker = `HISTORY_MIGRATE_${source}_TO_${target}`
      const history = historyAfterTool({ ...first.message }, marker)
      const offset = f.provider.snapshot().requests.length
      f.provider.enqueue({ text: marker }, { text: marker })
      const direct = await f.turn(target, false, history)
      const native = await f.turn(target, true, history)
      assert.equal(direct.message.stopReason, 'stop', direct.message.errorMessage)
      assert.equal(native.message.stopReason, 'stop', native.message.errorMessage)
      assert.deepEqual(native.message.content, direct.message.content)
      const requests = f.provider.snapshot().requests.slice(offset)
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[1].body, requests[0].body)
      const sent = JSON.stringify(requests[1].body)
      assert.ok(sent.includes(marker))
      assert.ok(sent.includes('cloud-call') || sent.includes('inspect'))
      assert.equal(
        sent.includes('opaque-tool-signature'),
        false,
        'Foreign Google signature cannot authorize a Bedrock tool result'
      )
    }
    assert.equal(f.stderr(), '')
    assert.equal((await f.snapshot()).logs.length, 0)
  }
)
