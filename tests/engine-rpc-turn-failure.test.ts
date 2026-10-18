import assert from 'node:assert/strict'
import test from 'node:test'

import { remoteTurnFailure } from '../src/main/agent/engine/rpc/turn-failure'
import { errorCodeOf, isRetryable } from '../src/shared/errorCodes'
import type { RpcPromptResult } from '../src/main/agent/engine/rpc/types'

function promptResult(overrides: Partial<RpcPromptResult> = {}): RpcPromptResult {
  return {
    type: 'prompt_result',
    id: 'p1',
    agentInvoked: true,
    status: 'error',
    sessionSettled: true,
    ...overrides
  }
}

test('a provider error keeps its retryable flag and a sanitized message', () => {
  const failure = remoteTurnFailure({
    outcome: 'failed',
    result: promptResult({
      error: {
        message: 'rate limited\nAuthorization: Bearer abcdef0123456789 sk-live-abcdefgh12345678',
        retryable: true,
        provider: 'anthropic',
        model: 'claude',
        httpStatus: 429
      }
    })
  })
  assert.equal(errorCodeOf(failure), 'PROVIDER_ERROR')
  assert.equal(isRetryable(failure), true)
  assert.match(failure.message, /anthropic/)
  assert.match(failure.message, /429/)
  assert.doesNotMatch(failure.message, /abcdef0123456789|sk-live|\n/)
})

test('provider error messages are bounded', () => {
  const failure = remoteTurnFailure({
    outcome: 'failed',
    result: promptResult({ error: { message: 'x'.repeat(5000), retryable: false } })
  })
  assert.ok(failure.message.length < 600)
  assert.equal(isRetryable(failure), false)
})

test('a denied approval and an aborted turn are not provider failures', () => {
  const denied = remoteTurnFailure({
    outcome: 'failed',
    result: promptResult({ status: 'completed' })
  })
  assert.equal(errorCodeOf(denied), 'APPROVAL_DENIED')
  const aborted = remoteTurnFailure({
    outcome: 'aborted',
    result: promptResult({ status: 'aborted' })
  })
  assert.equal(errorCodeOf(aborted), 'ABORTED')
})
