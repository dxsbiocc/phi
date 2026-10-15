import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProductionChildLedger,
  type VerifiedTaskLaunchExpectation
} from '../src/main/agent/engine/rpc/subagents/production-child-ledger'
import { ledgerOrigin, ledgerRun, ledgerStarted } from './helpers/productionChildNodeFixture'

function fixture(): {
  parent: ReturnType<typeof ledgerRun>['run']
  ledger: ProductionChildLedger
  origin: ReturnType<typeof ledgerOrigin>
  launch(patch?: Partial<VerifiedTaskLaunchExpectation>): VerifiedTaskLaunchExpectation
  finishParent(): void
} {
  const parent = ledgerRun()
  let current = parent.run as typeof parent.run | undefined
  const origin = ledgerOrigin(parent.run)
  const ledger = new ProductionChildLedger({
    phiSessionId: parent.run.sessionId,
    generation: 1,
    currentParentRun: () => current,
    onStop: () => {},
    allowBackground: true,
    maxChildrenPerTask: 4,
    requireDispatchSeal: true
  })
  const launch = (
    patch: Partial<VerifiedTaskLaunchExpectation> = {}
  ): VerifiedTaskLaunchExpectation => ({
    parentRunId: parent.run.runId,
    toolCallId: origin.origin.toolCallId,
    controlSequence: origin.origin.sequence,
    inputDigest: origin.origin.inputDigest,
    declaredTaskCount: 2,
    expectedTaskCount: 2,
    dispatchSealed: false,
    ...patch
  })
  return {
    parent: parent.run,
    ledger,
    origin,
    launch,
    finishParent: () => {
      current = undefined
    }
  }
}

test('parallel dispatch remains pending after the first start and until its authenticated seal and second start', async (t) => {
  const f = fixture()
  t.after(() => f.ledger.dispose())
  f.ledger.remember(f.origin)
  f.ledger.acceptTaskLaunch(f.launch())
  f.ledger.captureParent(ledgerStarted('a'))
  let settled = false
  const waiting = f.ledger.waitForStarts(f.parent.runId, new AbortController().signal).then(() => {
    settled = true
  })
  f.finishParent()
  f.ledger.acceptTaskLaunch(f.launch({ dispatchSealed: true }))
  await Promise.resolve()
  assert.equal(settled, false)
  assert.throws(() => f.ledger.assertNoPendingStarts(f.parent.runId), /pending native starts/)
  f.ledger.captureParent({ ...ledgerStarted('b'), detached: true })
  await waiting
  f.ledger.assertNoPendingStarts(f.parent.runId)
  assert.deepEqual(f.ledger.nativeIdsForParent(f.parent.runId), ['a', 'b'])
})

test('ordinary task-end frames cannot replace an authenticated dispatch seal', () => {
  const f = fixture()
  f.ledger.remember(f.origin)
  f.ledger.acceptTaskLaunch(f.launch())
  f.ledger.captureParent(ledgerStarted('a'))
  f.ledger.captureParent(ledgerStarted('b'))
  f.ledger.observeTaskEnd({
    type: 'tool_execution_end',
    toolName: 'task',
    toolCallId: 'outer-task',
    isError: false
  })
  assert.equal(f.ledger.hasPendingStarts(), true)
  f.ledger.acceptTaskLaunch(f.launch({ dispatchSealed: true }))
  assert.equal(f.ledger.hasPendingStarts(), false)
  f.ledger.acceptTaskLaunch(f.launch())
  assert.equal(f.ledger.hasPendingStarts(), false)
  f.ledger.dispose()
})

test('a partial admission seal accounts for only genuinely admitted children and zero does not forge no-spawn', () => {
  const f = fixture()
  f.ledger.remember(f.origin)
  f.ledger.acceptTaskLaunch(f.launch())
  f.ledger.captureParent(ledgerStarted('a'))
  f.ledger.acceptTaskLaunch(f.launch({ expectedTaskCount: 1, dispatchSealed: true }))
  f.ledger.assertNoPendingStarts(f.parent.runId)
  f.ledger.dispose()
  const empty = fixture()
  empty.ledger.remember(empty.origin)
  empty.ledger.acceptTaskLaunch(empty.launch({ expectedTaskCount: 0, dispatchSealed: true }))
  assert.throws(
    () => empty.ledger.assertNoPendingStarts(empty.parent.runId),
    /pending native starts/
  )
  empty.ledger.dispose()
})

test('a seal below observed native starts is a cancellation conflict rather than evidence that a child vanished', () => {
  const f = fixture()
  f.ledger.remember(f.origin)
  f.ledger.acceptTaskLaunch(f.launch())
  f.ledger.captureParent(ledgerStarted('a'))
  f.ledger.captureParent(ledgerStarted('b'))
  f.ledger.acceptTaskLaunch(f.launch({ expectedTaskCount: 1, dispatchSealed: true }))
  assert.equal(f.ledger.hasNoSpawnConflict(f.parent.runId), true)
  assert.throws(() => f.ledger.assertNoPendingStarts(f.parent.runId), /conflict/)
  assert.equal(f.ledger.nativeIdsForParent(f.parent.runId).length, 2)
  f.ledger.dispose()
})

test('an authenticated launch can precede its origin only for the same real registered parent', () => {
  const f = fixture()
  f.ledger.acceptTaskLaunch(f.launch())
  f.ledger.remember(f.origin)
  assert.throws(
    () => f.ledger.acceptTaskLaunch(f.launch({ inputDigest: 'f'.repeat(64) })),
    /differs/
  )
  assert.throws(
    () => f.ledger.acceptTaskLaunch(f.launch({ parentRunId: 'foreign-parent' })),
    /registered parent/
  )
  f.ledger.captureParent(ledgerStarted('a'))
  f.ledger.captureParent(ledgerStarted('b'))
  f.ledger.acceptTaskLaunch(f.launch({ dispatchSealed: true }))
  f.ledger.assertNoPendingStarts(f.parent.runId)
  f.ledger.dispose()
})
