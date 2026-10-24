import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ProductionChildRuntime } from '../src/main/agent/engine/rpc/subagents/production-child-runtime'
import { controlExchange, productionChildControlWire } from './helpers/productionChildControlWire'

async function runtime(
  f: Awaited<ReturnType<typeof productionChildControlWire>>,
  onFinished: (id: string, task?: string) => void = () => undefined,
  onError: (error: Error) => void = () => undefined
): Promise<ProductionChildRuntime> {
  return ProductionChildRuntime.create({
    connection: f.connection,
    execution: f.execution,
    prepared: f.prepared,
    root: f.root,
    currentParentRun: () => undefined,
    approval: {
      shouldGate: () => false,
      requestToolApproval: () => 'approved'
    },
    onDenied: () => undefined,
    onError,
    onChildFinished: (snapshot, _parent, task) => onFinished(snapshot.id, task),
    signal: f.connection.bindControl().signal
  })
}

test('idle host start admits only its signed native child and delivers completion', async (t) => {
  const f = await productionChildControlWire({ background: true, hostStart: 'valid' })
  t.after(f.close)
  const finished: string[] = []
  const finishedTasks: string[] = []
  const child = await runtime(
    f,
    (id, task) => {
      finished.push(id)
      if (task) finishedTasks.push(task)
    },
    (error) => assert.fail(error.message)
  )
  t.after(() => child.dispose())
  await assert.rejects(
    child.startHostChild('Writer', 'Wrong owner', randomUUID(), {
      ...f.root,
      phiSessionId: 'other-session'
    }),
    /owner differs/
  )
  const requestId = randomUUID()
  const starting = child.startHostChild('Writer', 'Complete a plan step', requestId, f.root)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(await controlExchange(f, f.request('register', 1)), true)
  assert.equal(await controlExchange(f, f.request('activate', 2)), true)
  const { runId } = await starting
  const run = child.status(runId)
  assert.equal(run.agent, 'Writer')
  assert.equal(run.phiSessionId, f.root.phiSessionId)
  assert.equal(run.background, true)
  await assert.rejects(
    child.startHostChild('Writer', 'Complete a plan step', requestId, f.root),
    /already belongs/
  )
  f.wire.emit(f.lifecycle('completed'))
  await child.awaitChildCompletionDelivery(runId)
  assert.deepEqual(finished, [runId])
  assert.deepEqual(finishedTasks, ['Complete a plan step'])
})

test('idle host start can be stopped and disconnect retires its controls', async (t) => {
  const f = await productionChildControlWire({ background: true, hostStart: 'valid' })
  t.after(f.close)
  const child = await runtime(f)
  t.after(() => child.dispose())
  const starting = child.startHostChild('Writer', 'Complete a plan step', randomUUID(), f.root)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(await controlExchange(f, f.request('register', 1)), true)
  assert.equal(await controlExchange(f, f.request('activate', 2)), true)
  const { runId } = await starting
  assert.equal((await child.stopChild(runId)).status, 'aborted')
  assert.deepEqual(f.cancelled, ['native-child'])
  f.wire.disconnect()
  await assert.rejects(
    child.startHostChild('Writer', 'Another step', randomUUID(), f.root),
    /RPC process exited|unavailable/
  )
})

test('forged host receipt fails closed and cannot grant a child run', async (t) => {
  const f = await productionChildControlWire({ background: true, hostStart: 'invalid-receipt' })
  t.after(f.close)
  const failures: string[] = []
  const child = await runtime(f, undefined, (error) => failures.push(error.message))
  t.after(() => child.dispose())
  await assert.rejects(
    child.startHostChild('Writer', 'Complete a plan step', randomUUID(), f.root),
    /authentication failed/
  )
  assert.throws(() => child.listRuns(), /unavailable/)
  assert.deepEqual(failures, ['Phi child host receipt authentication failed'])
})

test('missing receipt cancels its observed native child and closes the generation', async (t) => {
  const f = await productionChildControlWire({ background: true, hostStart: 'no-receipt' })
  t.after(f.close)
  const child = await runtime(f)
  t.after(() => child.dispose())
  await assert.rejects(child.startHostChild('Writer', 'Complete a plan step', randomUUID(), f.root))
  assert.deepEqual(f.cancelled, ['native-child'])
  assert.equal(f.wire.closeCalls(), 1)
})

test('missing receipt with unconfirmed host cancellation also cancels the observed native child', async (t) => {
  const f = await productionChildControlWire({
    background: true,
    hostStart: 'no-receipt',
    hostCancelState: 'unknown'
  })
  t.after(f.close)
  const child = await runtime(f)
  t.after(() => child.dispose())
  const requestId = randomUUID()
  await assert.rejects(
    child.startHostChild('Writer', 'Complete a plan step', requestId, f.root),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(requestId) &&
      (error as { code?: string }).code === 'TIMEOUT_UNKNOWN'
  )
  assert.deepEqual(f.cancelled, ['native-child'])
  assert.equal(f.wire.closeCalls(), 1)
})

test('quiescent host receipt cannot omit an observed native child', async (t) => {
  const f = await productionChildControlWire({
    background: true,
    hostStart: 'no-receipt',
    hostCancelOmitObserved: true
  })
  t.after(f.close)
  const child = await runtime(f)
  t.after(() => child.dispose())
  const requestId = randomUUID()
  await assert.rejects(
    child.startHostChild('Writer', 'Complete a plan step', requestId, f.root),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(requestId) &&
      (error as { code?: string }).code === 'TIMEOUT_UNKNOWN'
  )
  assert.deepEqual(f.cancelled, ['native-child'])
  assert.equal(f.wire.closeCalls(), 1)
})

test('remote UNKNOWN cancellation retires the generation without a retry', async (t) => {
  const f = await productionChildControlWire({
    background: true,
    hostStart: 'invalid-receipt',
    hostCancelState: 'unknown'
  })
  t.after(f.close)
  const child = await runtime(f)
  t.after(() => child.dispose())
  await assert.rejects(
    child.startHostChild('Writer', 'Complete a plan step', randomUUID(), f.root),
    /is UNKNOWN/
  )
  assert.deepEqual(f.cancelled, ['native-child'])
  assert.equal(f.wire.closeCalls(), 1)
})

test('pending lifecycle flood is bounded and cannot be revived by a later signed receipt', async (t) => {
  const f = await productionChildControlWire({
    background: true,
    hostStart: 'valid',
    hostStartFlood: true
  })
  t.after(f.close)
  const child = await runtime(f)
  t.after(() => child.dispose())
  await assert.rejects(
    child.startHostChild('Writer', 'Complete a plan step', randomUUID(), f.root),
    /pending bound/
  )
  assert.throws(() => child.listRuns(), /unavailable/)
  assert.equal(f.wire.closeCalls(), 1)
})

test('disconnect before receipt reports UNKNOWN for the persisted request ID', async (t) => {
  const f = await productionChildControlWire({
    background: true,
    hostStart: 'no-receipt',
    hostDisconnect: true
  })
  t.after(f.close)
  const child = await runtime(f)
  t.after(() => child.dispose())
  const requestId = randomUUID()
  await assert.rejects(
    child.startHostChild('Writer', 'Complete a plan step', requestId, f.root),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(requestId) &&
      (error as { code?: string }).code === 'TIMEOUT_UNKNOWN'
  )
  await assert.rejects(
    child.startHostChild('Writer', 'Duplicate step', requestId, f.root),
    /RPC process exited|not ready|unavailable|already belongs/
  )
})
