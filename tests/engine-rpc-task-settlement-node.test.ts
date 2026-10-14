import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ProductionChildLedger } from '../src/main/agent/engine/rpc/subagents/production-child-ledger'
import { ProductionChildRuntime } from '../src/main/agent/engine/rpc/subagents/production-child-runtime'
import {
  makeRpcTaskSettlement,
  type RpcTaskSettlement
} from '../src/main/agent/engine/phi-extension/lib/rpc-task-settlement-protocol'
import type { SessionRun } from '../src/main/agent/session/session-runner-registry'
import { ledgerRun, ledgerOrigin, ledgerStarted } from './helpers/productionChildNodeFixture'
import {
  productionChildControlWire,
  controlUntil,
  type ProductionChildControlWire
} from './helpers/productionChildControlWire'
import { deferred } from './helpers/rpc-initialization-wire'

// Synthetic peer only: consumers are production; actual SDK producer/composer evidence is separate.
async function runtime(
  t: TestContext,
  options: Parameters<typeof productionChildControlWire>[0] = {},
  currentParentRun?: () => SessionRun | undefined
): Promise<{ f: ProductionChildControlWire; child: ProductionChildRuntime; errors: Error[] }> {
  const f = await productionChildControlWire(options)
  t.after(f.close)
  const errors: Error[] = []
  const child = await ProductionChildRuntime.create({
    connection: f.connection,
    execution: f.execution,
    prepared: f.prepared,
    root: f.root,
    currentParentRun: currentParentRun ?? (() => f.parent.run),
    approval: {
      shouldGate: () => true,
      requestToolApproval: () => assert.fail('Retired parent cannot approve')
    },
    onDenied: () => undefined,
    onError: (error) => {
      errors.push(error)
    },
    signal: f.connection.bindControl().signal
  })
  t.after(() => child.dispose())
  return { f, child, errors }
}
function receipt(
  f: ProductionChildControlWire,
  patch: Partial<
    Pick<RpcTaskSettlement, 'parentRunId' | 'controlSequence' | 'toolCallId' | 'inputDigest'>
  > = {}
): Readonly<RpcTaskSettlement> {
  const origin = f.originMessage()
  if (!origin) throw new Error('Test requires its emitted origin')
  return makeRpcTaskSettlement(f.prepared.config, f.root, {
    parentRunId: origin.runId,
    controlSequence: origin.sequence,
    toolCallId: origin.toolCallId,
    inputDigest: origin.inputDigest,
    ...patch
  })
}
function emit(f: ProductionChildControlWire, proof: unknown): void {
  f.wire.emit({
    type: 'extension_ui_request',
    method: 'notify',
    notifyType: 'info',
    message: JSON.stringify(proof)
  })
}
function end(f: ProductionChildControlWire, toolCallId = 'outer-task'): void {
  f.wire.emit({ type: 'tool_execution_end', toolName: 'task', toolCallId, isError: true })
}

test('RPC end before extension proof stays pending until proof/start or the existing stop signal ends', async () => {
  const { run } = ledgerRun()
  const ledger = new ProductionChildLedger({
    phiSessionId: run.sessionId,
    generation: 1,
    currentParentRun: () => run,
    onStop: () => undefined
  })
  const controller = new AbortController()
  ledger.remember(ledgerOrigin(run))
  let state: 'pending' | 'resolved' | 'rejected' = 'pending'
  const waiting = ledger.waitForStarts(run.runId, controller.signal).then(
    () => {
      state = 'resolved'
    },
    () => {
      state = 'rejected'
    }
  )
  ledger.observeTaskEnd({
    type: 'tool_execution_end',
    toolName: 'task',
    toolCallId: 'outer-task',
    isError: true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(state, 'pending')
  assert.throws(() => ledger.assertNoPendingStarts(run.runId), /unconfirmed|pending/)
  controller.abort()
  await waiting
  ledger.dispose()
})

for (const order of ['end-first', 'proof-first'] as const)
  test(`authenticated ${order} no-spawn settles its exact origin and requires generation retirement`, async (t) => {
    const { f, child, errors } = await runtime(t)
    const main = await f.execution.beginRun(f.parent.run.runId)
    f.origin()
    const proof = receipt(f)
    if (order === 'end-first') end(f)
    emit(f, proof)
    assert.equal(main.signal.aborted, true)
    if (order === 'proof-first') end(f)
    assert.equal(child.needsGenerationRetirement(f.parent.run.runId), true)
    child.assertParentSettled(f.parent.run.runId)
    await child.stopParent(f.parent.run.runId)
    assert.deepEqual(f.cancelled, [])
    emit(f, proof)
    assert.deepEqual(errors, [])
  })

test('forged/stale/root/digest/control/parent/unbound receipts do not settle or revoke an unrelated main permit', async (t) => {
  const { f, child } = await runtime(t)
  await f.execution.beginRun(f.parent.run.runId)
  f.origin()
  const good = receipt(f),
    config = f.prepared.config
  const call = {
    parentRunId: good.parentRunId,
    controlSequence: good.controlSequence,
    toolCallId: good.toolCallId,
    inputDigest: good.inputDigest
  }
  const invalid: unknown[] = [
    { ...good, hmac: 'f'.repeat(64) },
    { ...good, extra: true },
    receipt(f, { parentRunId: 'other-parent' }),
    receipt(f, { controlSequence: good.controlSequence + 1 }),
    receipt(f, { toolCallId: 'unbound-outer' }),
    receipt(f, { inputDigest: 'a'.repeat(64) }),
    makeRpcTaskSettlement({ ...config, nonce: 'other-private-launch-nonce' }, f.root, call),
    makeRpcTaskSettlement({ ...config, manifestHash: 'a'.repeat(64) }, f.root, call),
    makeRpcTaskSettlement(config, { ...f.root, rootOmpSessionId: 'other-sdk' }, call),
    makeRpcTaskSettlement(config, { ...f.root, rootSessionFile: '/srv/history/other.jsonl' }, call),
    makeRpcTaskSettlement({ ...config, generation: 2 }, { ...f.root, generation: 2 }, call),
    makeRpcTaskSettlement(
      { ...config, projectId: 'other-project' },
      { ...f.root, projectId: 'other-project' },
      call
    )
  ]
  end(f)
  for (const proof of invalid) {
    emit(f, proof)
    assert.equal(f.execution.currentRun()?.signal.aborted, false)
    assert.equal(child.needsGenerationRetirement(f.parent.run.runId), false)
    assert.throws(() => child.assertParentSettled(f.parent.run.runId), /unconfirmed|pending/)
  }
  emit(f, good)
  await child.stopParent(f.parent.run.runId)
})

test('one receipt cannot settle a sibling with only task-end; EOF remains unconfirmed', async (t) => {
  const { f, child } = await runtime(t)
  await f.execution.beginRun(f.parent.run.runId)
  f.origin()
  const first = receipt(f)
  f.origin({ toolCallId: 'sibling-task', originSequence: 2, inputDigest: 'f'.repeat(64) })
  end(f)
  end(f, 'sibling-task')
  emit(f, first)
  let settled = false
  const stopping = child.stopParent(f.parent.run.runId).then(() => {
    settled = true
  })
  const failed = assert.rejects(stopping)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.throws(() => child.assertParentSettled(f.parent.run.runId), /unconfirmed|pending/)
  f.wire.disconnect()
  await failed
  assert.deepEqual(f.cancelled, [])
})

test('closed A receipt remains bound to A without revoking current B', async (t) => {
  let current: SessionRun | undefined
  const { f, child } = await runtime(t, {}, () => current)
  current = f.parent.run
  await f.execution.beginRun(current.runId)
  f.origin()
  const proofA = receipt(f)
  await f.execution.finishRun(current.runId)
  const b = ledgerRun('phi-session', 'parent-B')
  current = b.run
  const mainB = await f.execution.beginRun(b.run.runId)
  emit(f, proofA)
  assert.equal(mainB.signal.aborted, false)
  assert.equal(child.needsGenerationRetirement(f.parent.run.runId), true)
  assert.equal(child.needsGenerationRetirement(b.run.runId), false)
  await child.stopParent(f.parent.run.runId)
})

for (const order of ['late-start', 'already-started'] as const)
  test(`conflicting ${order} identity is retained for exact cancellation before generation fault`, async (t) => {
    const gate = deferred<void>()
    t.after(() => gate.resolve())
    const { f, child, errors } = await runtime(t, { cancelGate: gate.promise })
    await f.execution.beginRun(f.parent.run.runId)
    f.origin()
    if (order === 'already-started') f.wire.emit(f.lifecycle('started'))
    emit(f, receipt(f))
    if (order === 'late-start') {
      await child.stopParent(f.parent.run.runId)
      f.wire.emit(f.lifecycle('started'))
    }
    await controlUntil(() => f.cancelled.length === 1)
    assert.deepEqual(f.cancelled, ['native-child'])
    assert.equal(errors.length, 0)
    gate.resolve()
    await controlUntil(() => errors.length === 1)
    assert.match(errors[0].message, /no-spawn proof conflicts/i)
  })

test('same-generation no-spawn outer tombstone cannot be reused by B; fresh generation permits the new origin', async (t) => {
  const { f } = await runtime(t)
  const a = f.parent.run,
    b = ledgerRun('phi-session', 'parent-B').run
  let current = a
  const ledger = new ProductionChildLedger({
    phiSessionId: a.sessionId,
    generation: 1,
    currentParentRun: () => current,
    onStop: () => undefined,
    isNativeTerminal: () => true
  })
  ledger.remember(ledgerOrigin(a))
  await f.execution.beginRun(a.runId)
  f.origin()
  assert.equal(ledger.consumeNoSpawn(receipt(f)), a)
  assert.deepEqual(ledger.captureParent(ledgerStarted()), { runId: a.runId })
  current = b
  assert.throws(() => ledger.remember(ledgerOrigin(b)), /exact registered/)
  assert.equal(ledger.parentForNative('native-child'), a)
  const fresh = new ProductionChildLedger({
    phiSessionId: b.sessionId,
    generation: 2,
    currentParentRun: () => b,
    onStop: () => undefined
  })
  const next = ledgerOrigin(b)
  fresh.remember({ ...next, origin: { ...next.origin, generation: 2 } })
  assert.deepEqual(fresh.captureParent(ledgerStarted()), { runId: b.runId })
  ledger.dispose()
  fresh.dispose()
})
