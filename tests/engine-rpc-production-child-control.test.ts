import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProductionChildRuntime,
  attestProductionChildRuntime
} from '../src/main/agent/engine/rpc/subagents/production-child-runtime'
import type { RpcApprovalEvent } from '../src/main/agent/engine/rpc/approval-bridge'
import { createApprovalEnvelope } from '../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'
import { productionChildControlWire, controlExchange } from './helpers/productionChildControlWire'

test('production Node composition consumes verified task origins and routes durable child approvals to its exact parent', async (t) => {
  const f = await productionChildControlWire()
  t.after(f.close)
  const events: RpcApprovalEvent[] = []
  const denied: string[] = []
  const child = await ProductionChildRuntime.create({
    connection: f.connection,
    execution: f.execution,
    prepared: f.prepared,
    root: f.root,
    currentParentRun: () => f.parent.run,
    approval: {
      shouldGate: () => true,
      requestToolApproval: () => 'denied',
      onEvent: (event) => {
        events.push(event)
      }
    },
    onDenied: (parent) => {
      denied.push(parent.runId)
    },
    onError: (error) => assert.fail(error.message),
    signal: f.connection.bindControl().signal
  })
  t.after(() => child.dispose())
  await f.execution.beginRun(f.parent.run.runId)
  f.origin()
  f.wire.emit(f.lifecycle('started'))
  assert.equal(await controlExchange(f, f.request('register', 1)), true)
  assert.throws(() => child.assertParentSettled(f.parent.run.runId), /terminal lifecycle/)
  assert.equal(await controlExchange(f, f.request('activate', 2)), true)
  assert.equal(await controlExchange(f, f.request('approve', 3)), false)
  assert.deepEqual(
    events.map((event) => event.type),
    ['approval_requested', 'approval_denied']
  )
  assert.deepEqual(denied, [f.parent.run.runId])
  assert.notEqual(events[0].runId, f.parent.run.runId)
  assert.notEqual(events[0].runId, 'native-child')
  assert.equal(events[0].request.agentRunId, events[0].runId)
  assert.equal(child.parentForChild(events[0].runId), f.parent.run)
  assert.equal(events[0].sessionId, f.parent.run.sessionId)
  f.execution.revokeRun(f.parent.run.runId)
  assert.equal(f.execution.currentRun()?.signal.aborted, true)
  await f.execution.finishRun(f.parent.run.runId)
  await child.stopParent(f.parent.run.runId)
  assert.deepEqual(f.cancelled, ['native-child'])
  child.assertParentSettled(f.parent.run.runId)
})

test('synchronous main admission revoke rejects late approvals/origins while keeping the actual control writer alive', async (t) => {
  const f = await productionChildControlWire()
  t.after(f.close)
  const run = await f.execution.beginRun(f.parent.run.runId)
  let origins = 0
  const off = f.execution.onTaskOrigin(() => {
    origins++
  })
  t.after(off)
  const input = { path: '/srv/project/main.txt', content: 'MUST_NOT_WRITE' }
  const digest = createApprovalEnvelope(
    { ...f.execution.sessionIdentity(), runId: run.id },
    'main-write',
    'write',
    input
  ).inputDigest
  f.origin({ toolCallId: 'main-write', toolName: 'write', inputDigest: digest })
  const signal = new AbortController().signal
  assert.equal(run.authorizeCall('main-write', 'write', input, digest, signal), 'main')
  assert.throws(() => f.execution.revokeRun('different-parent'), /different run/)
  f.execution.revokeRun(run.id)
  f.execution.revokeRun(run.id)
  assert.equal(run.signal.aborted, true)
  assert.equal(run.authorizeCall('main-write', 'write', input, digest, signal), undefined)
  f.origin({ originSequence: 2 })
  assert.equal(origins, 0)
  assert.equal(f.connection.isReady, true)
  assert.equal(
    (await f.connection.request<{ sessionId: string }>({ type: 'get_state' })).sessionId,
    'root-sdk'
  )
  await f.execution.cancelRun()
  assert.equal(f.execution.currentRun(), undefined)
})

test('invalid HMAC origin never links an observed SDK start or admits a child tool', async (t) => {
  const f = await productionChildControlWire()
  t.after(f.close)
  let approvals = 0
  const child = await ProductionChildRuntime.create({
    connection: f.connection,
    execution: f.execution,
    prepared: f.prepared,
    root: f.root,
    currentParentRun: () => f.parent.run,
    approval: {
      shouldGate: () => true,
      requestToolApproval: () => {
        approvals++
        return 'approved'
      }
    },
    onDenied: () => assert.fail('No denial without a child'),
    onError: () => undefined,
    signal: f.connection.bindControl().signal
  })
  t.after(() => child.dispose())
  await f.execution.beginRun(f.parent.run.runId)
  f.origin({}, true)
  f.wire.emit(f.lifecycle('started'))
  assert.equal(await controlExchange(f, f.request('register', 1)), false)
  assert.equal(await controlExchange(f, f.request('activate', 2)), false)
  assert.equal(await controlExchange(f, f.request('approve', 3)), false)
  assert.equal(approvals, 0)
  await child.stopParent('unknown-parent')
  assert.deepEqual(f.cancelled, [])
})

test('default-disabled execution and a mismatched child attestation cannot activate the child composition', async (t) => {
  for (const options of [{ allowNativeTask: false }, { badAttestation: true }]) {
    const f = await productionChildControlWire(options)
    t.after(f.close)
    await assert.rejects(
      ProductionChildRuntime.create({
        connection: f.connection,
        execution: f.execution,
        prepared: f.prepared,
        root: f.root,
        currentParentRun: () => f.parent.run,
        approval: {
          shouldGate: () => true,
          requestToolApproval: () => assert.fail('No approval before attestation')
        },
        onDenied: () => undefined,
        onError: () => undefined,
        signal: f.connection.bindControl().signal
      }),
      /opt-in|attestation differs/
    )
  }
})

test('root AgentRegistry identity comes from authenticated attestation rather than a caller hardcoded ID', async (t) => {
  const f = await productionChildControlWire({ actualRootAgentId: 'ActualRegistryRoot' })
  t.after(f.close)
  const root = await attestProductionChildRuntime(
    f.connection,
    f.prepared.config,
    { rootOmpSessionId: f.root.rootOmpSessionId, rootSessionFile: f.root.rootSessionFile },
    f.connection.bindControl().signal
  )
  assert.equal(root.rootAgentId, 'ActualRegistryRoot')
  assert.equal(root.rootOmpSessionId, 'root-sdk')
  assert.ok(Object.isFrozen(root))
  await assert.rejects(
    attestProductionChildRuntime(
      f.connection,
      f.prepared.config,
      { rootOmpSessionId: 'wrong-sdk', rootSessionFile: f.root.rootSessionFile },
      f.connection.bindControl().signal
    ),
    /actual attached/
  )
})

test('attestation nonce/config/scope/generation tampering and a post-proof session/journal replacement all reject before task wiring', async (t) => {
  for (const options of [
    { attestationPatch: { nonce: 'other-generation-nonce' } },
    { attestationPatch: { configHash: 'f'.repeat(64) } },
    { attestationIdentityPatch: { projectId: 'other-project' } },
    { attestationIdentityPatch: { generation: 2 } },
    { stateChangeAfterAttest: 'session' as const },
    { stateChangeAfterAttest: 'journal' as const }
  ]) {
    const f = await productionChildControlWire(options)
    t.after(f.close)
    await assert.rejects(
      ProductionChildRuntime.create({
        connection: f.connection,
        execution: f.execution,
        prepared: f.prepared,
        root: f.root,
        currentParentRun: () => f.parent.run,
        approval: {
          shouldGate: () => true,
          requestToolApproval: () => assert.fail('No approval before attestation')
        },
        onDenied: () => undefined,
        onError: () => undefined,
        signal: f.connection.bindControl().signal
      }),
      /attestation|actual attached/
    )
    assert.equal(
      f.wire.commands.some((command) => command.type === 'set_host_uri_schemes'),
      false
    )
    assert.equal(
      f.wire.commands.some((command) => command.type === 'set_subagent_subscription'),
      false
    )
    assert.deepEqual(f.cancelled, [])
  }
})

test('stop with an authenticated pending origin stays unconfirmed until a late SDK start is actually cancelled', async (t) => {
  const f = await productionChildControlWire()
  t.after(f.close)
  const failures: Error[] = []
  const child = await ProductionChildRuntime.create({
    connection: f.connection,
    execution: f.execution,
    prepared: f.prepared,
    root: f.root,
    currentParentRun: () => f.parent.run,
    approval: {
      shouldGate: () => true,
      requestToolApproval: () => assert.fail('Stopped parent cannot approve')
    },
    onDenied: () => undefined,
    onError: (error) => {
      failures.push(error)
    },
    signal: f.connection.bindControl().signal
  })
  t.after(() => child.dispose())
  await f.execution.beginRun(f.parent.run.runId)
  f.origin()
  f.parent.controller.abort()
  let settled = false
  const stopping = child.stopParent(f.parent.run.runId).then(() => {
    settled = true
  })
  void stopping.catch(() => undefined)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(
    settled,
    false,
    'A signed origin awaiting started is not a confirmed empty child set'
  )
  assert.throws(() => child.assertParentSettled(f.parent.run.runId), /pending|terminal/)
  f.wire.emit(f.lifecycle('started'))
  await stopping
  assert.deepEqual(f.cancelled, ['native-child'])
  child.assertParentSettled(f.parent.run.runId)
  assert.equal(await controlExchange(f, f.request('register', 1)), false)
  assert.equal(await controlExchange(f, f.request('activate', 2)), false)
  assert.equal(await controlExchange(f, f.request('approve', 3)), false)
  assert.deepEqual(failures, [])
})

test('a verified late SDK start remains an outstanding native target after the parent permission was stopped', async (t) => {
  const f = await productionChildControlWire()
  t.after(f.close)
  const child = await ProductionChildRuntime.create({
    connection: f.connection,
    execution: f.execution,
    prepared: f.prepared,
    root: f.root,
    currentParentRun: () => f.parent.run,
    approval: {
      shouldGate: () => true,
      requestToolApproval: () => assert.fail('Stopped parent cannot approve')
    },
    onDenied: () => undefined,
    onError: () => undefined,
    signal: f.connection.bindControl().signal
  })
  t.after(() => child.dispose())
  await f.execution.beginRun(f.parent.run.runId)
  f.origin()
  f.parent.controller.abort()
  f.wire.emit(f.lifecycle('started'))
  await child.stopParent(f.parent.run.runId)
  assert.deepEqual(
    f.cancelled,
    ['native-child'],
    'Late real native ID must not vanish from cancellation'
  )
  child.assertParentSettled(f.parent.run.runId)
})

test('EOF while an authenticated native start is pending rejects stop and settlement rather than confirming no child', async (t) => {
  const f = await productionChildControlWire()
  t.after(f.close)
  const child = await ProductionChildRuntime.create({
    connection: f.connection,
    execution: f.execution,
    prepared: f.prepared,
    root: f.root,
    currentParentRun: () => f.parent.run,
    approval: { shouldGate: () => true, requestToolApproval: () => assert.fail('No approval') },
    onDenied: () => undefined,
    onError: () => undefined,
    signal: f.connection.bindControl().signal
  })
  t.after(() => child.dispose())
  await f.execution.beginRun(f.parent.run.runId)
  f.origin()
  const stopping = child.stopParent(f.parent.run.runId)
  const rejected = assert.rejects(stopping)
  f.wire.disconnect()
  await rejected
  assert.deepEqual(f.cancelled, [])
  assert.throws(() => child.assertParentSettled(f.parent.run.runId), /unavailable/)
  await assert.rejects(child.stopParent(f.parent.run.runId), /unavailable/)
})
