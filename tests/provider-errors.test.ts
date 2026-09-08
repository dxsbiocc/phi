import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getProviderErrorDisplay,
  isProviderBillingError,
  redactProviderErrorMessage
} from '../src/renderer/src/lib/providerErrors'

test('provider errors recognize insufficient balance responses as billing failures', () => {
  const message =
    '402 Insufficient Balance\nInsufficient Balance (type=unknown_error param=invalid_request_error)'
  const display = getProviderErrorDisplay(message)

  assert.equal(isProviderBillingError(message), true)
  assert.equal(display.title, '账户余额不足')
  assert.match(display.description, /充值/)
  assert.equal(display.showRawMessage, false)
  assert.equal(display.action, null)
})

test('provider errors keep missing provider failures actionable as configuration issues', () => {
  const display = getProviderErrorDisplay('没有配置 Provider 或可用模型')

  assert.equal(display.title, 'Provider 配置需要处理')
  assert.equal(display.showRawMessage, true)
  assert.equal(display.action, 'providerSettings')
  assert.equal(display.actionLabel, '去配置 Provider')
})

test('provider errors classify missing Kimi models as configuration issues', () => {
  const display = getProviderErrorDisplay(
    '404 Not found the model kimi-k2.5 or Permission denied (type=resource_not_found_error)'
  )

  assert.equal(display.title, 'Provider 配置需要处理')
  assert.equal(display.showRawMessage, true)
  assert.equal(display.action, 'providerSettings')
})

test('provider errors classify invalid authentication as configuration issue', () => {
  const display = getProviderErrorDisplay(
    '401 Invalid Authentication\nInvalid Authentication (type=invalid_authentication_error)'
  )

  assert.equal(display.title, 'API Key 无效或认证失败')
  assert.match(display.description, /重新配置/)
  assert.equal(display.showRawMessage, true)
  assert.equal(display.action, 'providerSettings')
  assert.equal(display.actionLabel, '去配置 Provider')
})

test('provider errors classify rate limits without leaking account identifiers', () => {
  const display = getProviderErrorDisplay(
    '429 Your account org-930ebedfe4d54cf998034940e3c937c1<ak-fch4ix7rq6wi11c3z111> request reached organization max RPM: 3, please try again after 1 seconds retry-after-ms=1000 (type=rate_limit_reached_error)'
  )

  assert.equal(display.title, '请求太频繁')
  assert.match(display.description, /稍等/)
  assert.equal(display.showRawMessage, true)
  assert.doesNotMatch(display.rawMessage, /org-930/)
  assert.doesNotMatch(display.rawMessage, /ak-fch/)
  assert.match(display.rawMessage, /\[redacted\]/)
})

test('provider error redaction removes common inline secrets', () => {
  assert.equal(
    redactProviderErrorMessage('failed api_key=abc123456789 Bearer tokenabc123456 sk-live123456'),
    'failed api_key=[redacted] Bearer [redacted] [redacted]'
  )
})
