import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deliverPlanReplanPrompt,
  PlanReplanCancellationError,
  retryPlanReplanCancellation
} from '../src/renderer/src/features/plan/lib/planReplanDelivery'
import { planReplanRecoveryStore } from '../src/renderer/src/features/plan/lib/planReplanRecoveryStore'

test('late cancel failure notifies a replacement panel and retains exact retry target', async () => {
  const key = 'remount-session:remount-run'
  let failCancellation!: (cause: Error) => void
  const cancellation = new Promise<void>((_resolve, reject) => {
    failCancellation = reject
  })
  const delivery = deliverPlanReplanPrompt({
    request: { requestId: 'remount-request', runId: 'remount-run', prompt: 'Replan' },
    phiSessionId: 'remount-session',
    isCurrent: () => false,
    send: async () => true,
    cancel: () => cancellation
  })

  const firstPanelUpdates: number[] = []
  const unmount = planReplanRecoveryStore.subscribe(() =>
    firstPanelUpdates.push(planReplanRecoveryStore.snapshot())
  )
  unmount()
  const replacementUpdates: number[] = []
  const unmountReplacement = planReplanRecoveryStore.subscribe(() =>
    replacementUpdates.push(planReplanRecoveryStore.snapshot())
  )
  try {
    failCancellation(new Error('transport unavailable'))
    let failure: PlanReplanCancellationError | null = null
    try {
      await delivery
    } catch (cause) {
      assert.ok(cause instanceof PlanReplanCancellationError)
      failure = cause
    }
    assert.ok(failure)
    planReplanRecoveryStore.set(key, failure.pending)
    assert.deepEqual(firstPanelUpdates, [])
    assert.equal(replacementUpdates.length, 1)
    assert.equal(planReplanRecoveryStore.get(key)?.requestId, 'remount-request')

    const retried: string[] = []
    await retryPlanReplanCancellation(failure.pending, async (...ids) => {
      retried.push(...ids)
    })
    planReplanRecoveryStore.delete(key)
    assert.deepEqual(retried, ['remount-session', 'remount-run', 'remount-request'])
    assert.equal(planReplanRecoveryStore.get(key), undefined)
    assert.equal(replacementUpdates.length, 2)
  } finally {
    unmountReplacement()
    planReplanRecoveryStore.delete(key)
  }
})
