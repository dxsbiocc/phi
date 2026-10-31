import assert from 'node:assert/strict'
import { it } from 'node:test'

import {
  COMPACTION_NOT_NEEDED_MESSAGE,
  isCompactionNoOpError,
  isSdkCompactionNoOp
} from '../src/shared/errorCodes'

it('tells a compaction no-op apart from a real failure', () => {
  assert.equal(isSdkCompactionNoOp('Nothing to compact (session too small)'), true)
  assert.equal(isSdkCompactionNoOp('Already compacted'), true)
  assert.equal(isSdkCompactionNoOp('Error: 429 rate limited'), false)
  assert.equal(isSdkCompactionNoOp(COMPACTION_NOT_NEEDED_MESSAGE), false)
  assert.equal(isCompactionNoOpError(new Error('Already compacted')), true)
  assert.equal(isCompactionNoOpError({ detail: { reason: 'compaction_not_needed' } }), true)
  assert.equal(isCompactionNoOpError(new Error('The requested capability is unavailable.')), false)
})
