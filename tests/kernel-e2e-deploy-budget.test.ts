import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deployTimeoutMs,
  deployUploadBytes,
  effectiveDeadlineMinutes,
  MIN_DEPLOY_BYTES_PER_SECOND
} from '../scripts/kernel-e2e/deploy-budget'

const MB = 1024 * 1024

test('deploy upload counts the kernel plus only the largest native variant', () => {
  const bytes = deployUploadBytes({
    files: [
      { role: 'kernel', size: 142 * MB },
      { role: 'native', size: 115 * MB },
      { role: 'native', size: 114 * MB }
    ]
  })
  assert.equal(bytes, 257 * MB)
  assert.throws(() => deployUploadBytes({ files: [{ role: 'native', size: MB }] }))
})

test('deploy timeout covers the upload at 0.2 MB/s plus fixed overhead', () => {
  const bytes = 257 * MB
  const timeout = deployTimeoutMs(bytes)
  assert.ok(timeout >= (bytes / MIN_DEPLOY_BYTES_PER_SECOND) * 1000)
  assert.equal(Math.round(timeout / 60_000), Math.round(1285 / 60 + 3))
})

test('the overall deadline only extends to fit the deploy budget', () => {
  assert.equal(effectiveDeadlineMinutes(30, 5 * 60_000), 30)
  assert.equal(effectiveDeadlineMinutes(30, 25 * 60_000), 40)
  assert.equal(effectiveDeadlineMinutes(90, 25 * 60_000), 90)
})
