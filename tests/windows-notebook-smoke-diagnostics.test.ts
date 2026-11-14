import assert from 'node:assert/strict'
import test from 'node:test'

import { safeDiagnosticText } from '../scripts/runtime/windows-notebook-smoke-diagnostics'

test('safeDiagnosticText hides Authorization Bearer, cookie, and query values', () => {
  const bearerSecret = 'synthetic-bearer-secret'
  const cookieSecret = 'synthetic-cookie-secret'
  const querySecret = 'synthetic-query-secret'
  const redacted = safeDiagnosticText(
    `Authorization: Bearer ${bearerSecret}\ncookie: session=${cookieSecret}\nGET http://127.0.0.1:18888/lab?token=${querySecret}&safe=1`
  )

  assert.equal(redacted.includes(bearerSecret), false)
  assert.equal(redacted.includes(cookieSecret), false)
  assert.equal(redacted.includes(querySecret), false)
  assert.match(redacted, /Authorization=<redacted>/)
  assert.match(redacted, /cookie=<redacted>/)
  assert.match(redacted, /token=/)
})

test('safeDiagnosticText bounds every diagnostic string by the requested limit', () => {
  assert.equal(safeDiagnosticText('x'.repeat(600)).length, 500)
  assert.equal(safeDiagnosticText('x'.repeat(600), 25).length, 25)
})
