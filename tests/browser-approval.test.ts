import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BrowserActionApprovalLeases,
  browserActionApprovalRequirement,
  type BrowserActionApprovalIdentity
} from '../src/main/browser/browser-approval'

const identity: BrowserActionApprovalIdentity = {
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  requestId: 'request-1',
  tabId: 'tab-1',
  origin: 'https://example.test',
  documentRevision: 7,
  action: 'click',
  consequence: 'write',
  targetFingerprint: 'target-1',
  targetDescriptorDigest: 'descriptor-digest-1',
  textDigest: null,
  actionDigest: 'action-digest-1'
}

const prompt = {
  sessionId: identity.sessionId,
  runId: identity.runId,
  toolCallId: identity.toolCallId,
  origin: identity.origin,
  action: identity.action,
  consequence: identity.consequence,
  reason: 'external_origin' as const
}

test('browser action approval policy bypasses ordinary loopback input and confirms external input', () => {
  assert.deepEqual(
    browserActionApprovalRequirement({
      url: 'http://localhost:3000/form?private=sentinel',
      action: 'typeText',
      consequence: 'write',
      submitsForm: false
    }),
    { kind: 'allow' }
  )
  assert.deepEqual(
    browserActionApprovalRequirement({
      url: 'https://example.test/form?private=sentinel',
      action: 'typeText',
      consequence: 'write',
      submitsForm: false
    }),
    { kind: 'confirm', reason: 'external_origin' }
  )
})

test('browser action approval policy confirms submit and irreversible actions on loopback', () => {
  assert.deepEqual(
    browserActionApprovalRequirement({
      url: 'http://127.0.0.1:3000/form',
      action: 'click',
      consequence: 'write',
      submitsForm: true
    }),
    { kind: 'confirm', reason: 'form_submission' }
  )
  assert.deepEqual(
    browserActionApprovalRequirement({
      url: 'http://localhost:3000/settings',
      action: 'click',
      consequence: 'irreversible',
      submitsForm: false
    }),
    { kind: 'confirm', reason: 'irreversible' }
  )
})

test('an approved browser action lease is exact, one-shot, memory-only state', async () => {
  const leases = new BrowserActionApprovalLeases()
  const approved = await leases.request(identity, prompt, async () => 'approved')
  assert.equal(approved, 'approved')

  for (const mismatch of [
    { ...identity, sessionId: 'session-2' },
    { ...identity, runId: 'run-2' },
    { ...identity, toolCallId: 'tool-2' },
    { ...identity, requestId: 'request-2' },
    { ...identity, tabId: 'tab-2' },
    { ...identity, origin: 'https://other.test' },
    { ...identity, documentRevision: 8 },
    { ...identity, action: 'typeText' as const },
    { ...identity, consequence: 'irreversible' as const },
    { ...identity, targetFingerprint: 'target-2' },
    { ...identity, targetDescriptorDigest: 'descriptor-digest-2' },
    { ...identity, textDigest: 'text-digest-2' },
    { ...identity, actionDigest: 'action-digest-2' }
  ]) {
    assert.equal(leases.consume(mismatch), false)
  }
  assert.equal(leases.consume(identity), true)
  assert.equal(leases.consume(identity), false)
  assert.deepEqual(leases.snapshotForTesting(), [])
})

test('browser action approval cancellation and invalidation never create a lease', async () => {
  const leases = new BrowserActionApprovalLeases()
  let approvalSignal: AbortSignal | undefined
  const pending = leases.request(identity, prompt, async (_request, signal) => {
    approvalSignal = signal
    return new Promise<'approved'>((resolve) => {
      signal.addEventListener('abort', () => resolve('approved'), { once: true })
    })
  })
  await Promise.resolve()
  leases.invalidateTab(identity.tabId)

  assert.equal(approvalSignal?.aborted, true)
  assert.equal(await pending, 'cancelled')
  assert.equal(leases.consume(identity), false)

  await leases.request(identity, prompt, async () => 'approved')
  leases.invalidateRun(identity.runId)
  assert.equal(leases.consume(identity), false)
})

test('an abort after approval but before consumption revokes the granted lease', async () => {
  const leases = new BrowserActionApprovalLeases()
  const controller = new AbortController()
  assert.equal(
    await leases.request(identity, prompt, async () => 'approved', controller.signal),
    'approved'
  )
  controller.abort()
  assert.equal(leases.consume(identity), false)
  assert.deepEqual(leases.snapshotForTesting(), [])
})
