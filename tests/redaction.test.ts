import assert from 'node:assert/strict'
import test from 'node:test'

import { isSecretMetadataKey, redactSensitiveText } from '../src/main/agent/redaction'

test('redactSensitiveText removes common secret shapes while keeping context', () => {
  const text =
    'request failed api_key=sk-live-secret12345 with Bearer abcdefghijklmnop and token: plain-secret'

  const redacted = redactSensitiveText(text)

  assert.equal(
    redacted,
    'request failed api_key=[redacted] with Bearer [redacted] and token: [redacted]'
  )
})

test('redactSensitiveText removes Kimi account and key fragments', () => {
  const text =
    '429 Your account org-930ebedfe4d54cf998034940e3c937c1<ak-fch4ix7rq6wi11c3z111> request reached organization max RPM'

  const redacted = redactSensitiveText(text)

  assert.equal(redacted, '429 Your account [redacted] request reached organization max RPM')
})

test('isSecretMetadataKey only treats exact secret fields as removable', () => {
  assert.equal(isSecretMetadataKey('apiKey'), true)
  assert.equal(isSecretMetadataKey('token'), true)
  assert.equal(isSecretMetadataKey('statusText'), false)
  assert.equal(isSecretMetadataKey('tokenCount'), false)
})
