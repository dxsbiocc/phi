import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TRANSFER_POLICY,
  TransferError,
  TransferStateError,
  transitionTransferState
} from '../src/main/agent/transfer'
import { sameSourceIdentity } from '../src/main/agent/transfer/manifest'

test('transfer defaults and state transitions follow the R7 contract', () => {
  assert.deepEqual(DEFAULT_TRANSFER_POLICY, {
    globalConcurrency: 2,
    perHostConcurrency: 1,
    perDestinationConcurrency: 1,
    chunkSizeBytes: 8 * 1024 * 1024,
    checkpointBytes: 64 * 1024 * 1024,
    checkpointIntervalMs: 5_000,
    progressIntervalMs: 250,
    progressBytes: 1024 * 1024,
    retainedPartialTtlMs: 7 * 24 * 60 * 60 * 1000,
    retainedPartialHostMaxBytes: 20 * 1024 * 1024 * 1024,
    retainedPartialFreeSpaceFraction: 0.1
  })

  assert.equal(transitionTransferState('queued', 'preparing'), 'preparing')
  assert.equal(transitionTransferState('preparing', 'transferring'), 'transferring')
  assert.equal(transitionTransferState('transferring', 'verifying'), 'verifying')
  assert.equal(transitionTransferState('verifying', 'publishing'), 'publishing')
  assert.equal(transitionTransferState('publishing', 'saved'), 'saved')
  assert.equal(transitionTransferState('transferring', 'paused'), 'paused')
  assert.equal(transitionTransferState('paused', 'queued'), 'queued')

  assert.throws(
    () => transitionTransferState('queued', 'saved'),
    (error: unknown) => error instanceof TransferStateError && error.code === 'INVALID_STATE'
  )
  assert.throws(() => transitionTransferState('saved', 'queued'), TransferStateError)
})

test('transfer errors remain byte-bounded when UTF-8 text crosses the truncation boundary', () => {
  const error = new TransferError('TRANSFER_FAILED', `${'a'.repeat(1020)}${'💥'.repeat(100)}`)

  assert.ok(Buffer.byteLength(error.message) <= 1024)
  assert.ok(error.message.endsWith('...'))
})

test('helper and pure SSH identities for the same file are resume-compatible', () => {
  const helper = {
    kind: 'file',
    device: '42',
    inode: '99',
    size: 1234,
    mtime: '2026-10-11T08:09:10.123456789Z'
  }
  const ssh = {
    ...helper,
    kind: 'ssh-file-v1',
    mtime: '2026-10-11 08:09:10.123456789 +0000'
  }

  assert.equal(sameSourceIdentity(helper, ssh), true)
  assert.equal(sameSourceIdentity(helper, { ...ssh, inode: '100' }), false)
  assert.equal(
    sameSourceIdentity(helper, { ...ssh, mtime: '2026-10-11 08:09:11.123456789 +0000' }),
    false
  )
})
