import assert from 'node:assert/strict'
import test from 'node:test'

import { remoteMicromambaPath } from '../src/shared/remoteMicromambaTypes'

test('builds the versioned remote micromamba executable path', () => {
  assert.equal(
    remoteMicromambaPath('/data/runtime', '2.9.0-0'),
    '/data/runtime/bin/micromamba-2.9.0-0/micromamba'
  )
  assert.equal(
    remoteMicromambaPath('~/.phi/runtime/', '2.9.0-0'),
    '~/.phi/runtime/bin/micromamba-2.9.0-0/micromamba'
  )
})

test('rejects a release value that could escape the version directory', () => {
  assert.throws(() => remoteMicromambaPath('/data/runtime', '../micromamba'), /invalid remote/)
})
