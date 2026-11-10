import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deliverPlanReplanPrompt,
  PlanReplanCancellationError,
  retryPlanReplanCancellation
} from '../src/renderer/src/features/plan/lib/planReplanDelivery'

const request = { requestId: 'request-1', runId: 'run-1', prompt: 'Replan the remaining steps' }

test('navigation away cancels the exact replan request without sending', async () => {
  const calls: string[] = []
  const accepted = await deliverPlanReplanPrompt({
    request,
    phiSessionId: 'session-1',
    isCurrent: () => false,
    send: async () => {
      calls.push('send')
      return true
    },
    cancel: async (requestId) => {
      calls.push(`cancel:${requestId}`)
    }
  })
  assert.equal(accepted, false)
  assert.deepEqual(calls, ['cancel:request-1'])
})

test('rejected send cancels the request', async () => {
  const cancelled: string[] = []
  const accepted = await deliverPlanReplanPrompt({
    request,
    phiSessionId: 'session-1',
    isCurrent: () => true,
    send: async () => false,
    cancel: async (requestId) => {
      cancelled.push(requestId)
    }
  })
  assert.equal(accepted, false)
  assert.deepEqual(cancelled, ['request-1'])
})

test('a stopped run cancels the request and reports stopped', async () => {
  const cancelled: string[] = []
  const result = await deliverPlanReplanPrompt({
    request,
    phiSessionId: 'session-1',
    isCurrent: () => true,
    send: async () => 'stopped',
    cancel: async (requestId) => {
      cancelled.push(requestId)
    }
  })
  assert.equal(result, 'stopped')
  assert.deepEqual(cancelled, ['request-1'])
})

test('a stopped run ignores a cancellation failure instead of raising it', async () => {
  const result = await deliverPlanReplanPrompt({
    request,
    phiSessionId: 'session-1',
    isCurrent: () => true,
    send: async () => 'stopped',
    cancel: async () => {
      throw new Error('conversation is still stopping')
    }
  })
  assert.equal(result, 'stopped')
})

test('send error cancels the request while preserving the original error', async () => {
  const cancelled: string[] = []
  await assert.rejects(
    deliverPlanReplanPrompt({
      request,
      phiSessionId: 'session-1',
      isCurrent: () => true,
      send: async () => {
        throw new Error('send failed')
      },
      cancel: async (requestId) => {
        cancelled.push(requestId)
      }
    }),
    /send failed/
  )
  assert.deepEqual(cancelled, ['request-1'])
})

test('failed cancellation retains exact identity for a retry', async () => {
  let pending: PlanReplanCancellationError | null = null
  try {
    await deliverPlanReplanPrompt({
      request,
      phiSessionId: 'session-1',
      isCurrent: () => false,
      send: async () => true,
      cancel: async () => {
        throw new Error('transport unavailable')
      }
    })
  } catch (cause) {
    assert.ok(cause instanceof PlanReplanCancellationError)
    pending = cause
  }
  assert.ok(pending)
  assert.deepEqual(pending.pending, {
    phiSessionId: 'session-1',
    runId: 'run-1',
    requestId: 'request-1'
  })
  const retried: string[] = []
  await retryPlanReplanCancellation(pending.pending, async (sessionId, runId, requestId) => {
    retried.push(sessionId, runId, requestId)
  })
  assert.deepEqual(retried, ['session-1', 'run-1', 'request-1'])
})

test('accepted prompt retains the request even if navigation changes while sending', async () => {
  let current = true
  let release!: (accepted: boolean) => void
  const sent = new Promise<boolean>((resolve) => {
    release = resolve
  })
  const cancelled: string[] = []
  const result = deliverPlanReplanPrompt({
    request,
    phiSessionId: 'session-1',
    isCurrent: () => current,
    send: async (sessionId, prompt) => {
      assert.equal(sessionId, 'session-1')
      assert.equal(prompt, request.prompt)
      return sent
    },
    cancel: async (requestId) => {
      cancelled.push(requestId)
    }
  })
  current = false
  release(true)
  assert.equal(await result, true)
  assert.deepEqual(cancelled, [])
})
