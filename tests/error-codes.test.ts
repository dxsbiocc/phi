import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodedError,
  ERROR_CODES,
  errorCodeOf,
  errorMessage,
  isErrorCode,
  isRetryable,
  toErrorPayload
} from '../src/shared/errorCodes'

test('every code declares retryable and only timeouts/provider/transport are retryable', () => {
  assert.equal(ERROR_CODES.TRANSPORT_LOST.retryable, true)
  assert.equal(ERROR_CODES.TIMEOUT_UNKNOWN.retryable, false)
  assert.equal(ERROR_CODES.APPROVAL_DENIED.retryable, false)
  assert.equal(ERROR_CODES.ABORTED.retryable, false)
  assert.equal(ERROR_CODES.UNKNOWN.retryable, false)
  for (const entry of Object.values(ERROR_CODES)) assert.equal(typeof entry.retryable, 'boolean')
})

test('errorCodeOf reads a known code and falls back to UNKNOWN', () => {
  assert.equal(errorCodeOf(new CodedError('TRANSPORT_LOST', 'x')), 'TRANSPORT_LOST')
  assert.equal(
    errorCodeOf(Object.assign(new Error('x'), { code: 'DOMAIN_NOT_FOUND' })),
    'DOMAIN_NOT_FOUND'
  )
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { code: 'host_key_changed' })), 'UNKNOWN')
  assert.equal(errorCodeOf(new Error('SSH 连接已关闭')), 'UNKNOWN')
  assert.equal(errorCodeOf('boom'), 'UNKNOWN')
  assert.equal(errorCodeOf(null), 'UNKNOWN')
  assert.equal(isErrorCode('ABORTED'), true)
  assert.equal(isErrorCode('nope'), false)
})

test('CodedError retryable defaults to the code and can be overridden', () => {
  assert.equal(new CodedError('PROVIDER_ERROR', 'x').retryable, false)
  assert.equal(new CodedError('PROVIDER_ERROR', 'x', { retryable: true }).retryable, true)
  assert.equal(new CodedError('TRANSPORT_LOST', 'x').retryable, true)
  assert.equal(isRetryable(new CodedError('PROVIDER_ERROR', 'x', { retryable: true })), true)
  assert.equal(isRetryable(new Error('x')), false)
})

test('toErrorPayload serializes code, retryable and message only', () => {
  const error = new CodedError('TIMEOUT_UNKNOWN', 'SSH 命令超时', { cause: new Error('secret') })
  assert.deepEqual(toErrorPayload(error), {
    code: 'TIMEOUT_UNKNOWN',
    retryable: false,
    message: 'SSH 命令超时'
  })
  assert.deepEqual(toErrorPayload(new Error('plain')), {
    code: 'UNKNOWN',
    retryable: false,
    message: 'plain'
  })
  assert.deepEqual(toErrorPayload('str'), { code: 'UNKNOWN', retryable: false, message: 'str' })
})

test('errorMessage never renders an empty explanation', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  // An Error with no message falls back to its string form instead of ''.
  assert.equal(errorMessage(new Error('')), 'Error')
  assert.equal(errorMessage(Object.assign(new Error(''), { name: 'TimeoutError' })), 'TimeoutError')
  assert.equal(errorMessage('plain string'), 'plain string')
  assert.equal(errorMessage(undefined), 'undefined')
})
