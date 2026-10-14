import assert from 'node:assert/strict'
import test from 'node:test'
import { ProductionChildLedger } from '../src/main/agent/engine/rpc/subagents/production-child-ledger'
import { ledgerRun, ledgerOrigin, ledgerStarted } from './helpers/productionChildNodeFixture'

test('parent ledger retains exact signed-origin association after a normal parent turn finishes', () => {
  const { run } = ledgerRun()
  let current = run as typeof run | undefined
  const ledger = new ProductionChildLedger({
    phiSessionId: run.sessionId,
    generation: 1,
    currentParentRun: () => current,
    onStop: () => assert.fail('Normal finish must not stop child')
  })
  ledger.remember(ledgerOrigin(run))
  current = undefined
  run.outcome = 'completed'
  assert.deepEqual(ledger.captureParent(ledgerStarted()), { runId: run.runId })
  assert.equal(ledger.parentForNative('native-child'), run)
  assert.equal(ledger.parent(run.runId), run)
  ledger.dispose()
  assert.equal(ledger.parentForNative('native-child'), undefined)
})

test('parent ledger rejects self-reported starts, origin replay, second child and replacement SessionRun', () => {
  const { run } = ledgerRun()
  let current = run
  const ledger = new ProductionChildLedger({
    phiSessionId: run.sessionId,
    generation: 1,
    currentParentRun: () => current,
    onStop: () => undefined
  })
  assert.equal(ledger.captureParent(ledgerStarted()), undefined)
  ledger.remember(ledgerOrigin(run))
  assert.throws(() => ledger.remember(ledgerOrigin(run)), /exact registered/)
  ledger.captureParent(ledgerStarted())
  assert.equal(ledger.captureParent(ledgerStarted('second-child')), undefined)
  current = { ...run }
  assert.throws(
    () => ledger.remember(ledgerOrigin(current, 'second-task')),
    /identity was replaced/
  )
  ledger.dispose()
})

test('explicit stop revokes that parent while another session ledger remains live', () => {
  const a = ledgerRun(),
    b = ledgerRun('other-session')
  const stopped: string[] = []
  const first = new ProductionChildLedger({
    phiSessionId: a.run.sessionId,
    generation: 1,
    currentParentRun: () => a.run,
    onStop: (run) => stopped.push(run.sessionId)
  })
  const second = new ProductionChildLedger({
    phiSessionId: b.run.sessionId,
    generation: 1,
    currentParentRun: () => b.run,
    onStop: (run) => stopped.push(run.sessionId)
  })
  first.remember(ledgerOrigin(a.run))
  second.remember(ledgerOrigin(b.run))
  a.controller.abort()
  assert.deepEqual(stopped, ['phi-session'])
  assert.deepEqual(first.captureParent(ledgerStarted()), { runId: a.run.runId })
  assert.equal(first.parentForNative('native-child')?.signal.aborted, true)
  assert.deepEqual(second.captureParent(ledgerStarted()), { runId: b.run.runId })
  first.dispose()
  second.dispose()
})

test('wrong generation, session or active-run identity never admits a parent task', () => {
  const { run } = ledgerRun()
  const ledger = new ProductionChildLedger({
    phiSessionId: run.sessionId,
    generation: 1,
    currentParentRun: () => run,
    onStop: () => undefined
  })
  const base = ledgerOrigin(run)
  for (const patch of [
    { generation: 2 },
    { phiSessionId: 'other-session' },
    { runId: 'other-run' },
    { toolName: 'write' }
  ])
    assert.throws(
      () => ledger.remember({ ...base, origin: { ...base.origin, ...patch } }),
      /exact registered/
    )
  ledger.dispose()
})

test('a later real parent turn can reuse an outer ID only after its previous verified native terminal', () => {
  const first = ledgerRun(),
    second = ledgerRun('phi-session', 'next-parent-run')
  let current = first.run,
    terminal = false
  const ledger = new ProductionChildLedger({
    phiSessionId: first.run.sessionId,
    generation: 1,
    currentParentRun: () => current,
    onStop: () => undefined,
    isNativeTerminal: (nativeId, parentRunId) =>
      terminal && nativeId === 'first-child' && parentRunId === first.run.runId
  })
  ledger.remember(ledgerOrigin(first.run))
  ledger.captureParent(ledgerStarted('first-child'))
  current = second.run
  assert.throws(() => ledger.remember(ledgerOrigin(second.run)), /exact registered/)
  terminal = true
  ledger.remember(ledgerOrigin(second.run))
  assert.deepEqual(ledger.captureParent(ledgerStarted('second-child')), { runId: second.run.runId })
  assert.equal(ledger.parentForNative('first-child'), first.run)
  assert.equal(ledger.parentForNative('second-child'), second.run)
  assert.throws(() => ledger.remember(ledgerOrigin(second.run)), /exact registered/)
  ledger.dispose()
})

test('pending authenticated origins reject settlement and caller abort/timeout instead of confirming an empty set', async () => {
  const { run } = ledgerRun()
  const ledger = new ProductionChildLedger({
    phiSessionId: run.sessionId,
    generation: 1,
    currentParentRun: () => run,
    onStop: () => undefined
  })
  ledger.remember(ledgerOrigin(run))
  assert.throws(() => ledger.assertNoPendingStarts(run.runId), /pending native starts/)
  const cancelled = new AbortController()
  const waiting = ledger.waitForStarts(run.runId, cancelled.signal)
  cancelled.abort(new Error('Stop signal ended'))
  await assert.rejects(waiting, /Stop signal ended/)
  const timed = ledger.waitForStarts(run.runId, AbortSignal.timeout(5))
  const results = await Promise.allSettled([
    timed,
    new Promise((resolve) => setTimeout(resolve, 15))
  ])
  assert.equal(results[0].status, 'rejected')
  assert.throws(() => ledger.assertNoPendingStarts(run.runId), /pending native starts/)
  ledger.dispose()
})

test('an actual task-end envelope without observed start rejects confirmation and does not erase its origin', async () => {
  const { run } = ledgerRun()
  const ledger = new ProductionChildLedger({
    phiSessionId: run.sessionId,
    generation: 1,
    currentParentRun: () => run,
    onStop: () => undefined
  })
  ledger.remember(ledgerOrigin(run))
  const waiting = ledger.waitForStarts(run.runId, new AbortController().signal)
  ledger.observeTaskEnd({
    type: 'tool_execution_end',
    toolName: 'task',
    toolCallId: 'foreign-call',
    isError: true
  })
  assert.throws(() => ledger.assertNoPendingStarts(run.runId), /pending native starts/)
  ledger.observeTaskEnd({
    type: 'tool_execution_end',
    toolName: 'task',
    toolCallId: 'outer-task',
    isError: true
  })
  assert.throws(() => ledger.assertNoPendingStarts(run.runId), /unconfirmed/)
  assert.deepEqual(ledger.captureParent(ledgerStarted()), { runId: run.runId })
  await waiting
  ledger.assertNoPendingStarts(run.runId)
  ledger.dispose()
})
