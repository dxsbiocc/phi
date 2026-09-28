import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BackgroundAgentApprovalTracker,
  type BackgroundApprovalRequest
} from '../src/main/agent/agents/background-approval'
import type {
  PhiSessionManifest,
  SessionEventInput,
  StoredSessionEvent
} from '../src/main/agent/session/session-store'

function fixture(): {
  tracker: BackgroundAgentApprovalTracker
  manifest: PhiSessionManifest
  events: StoredSessionEvent[]
  changes: () => number
} {
  const manifest = {
    sessionId: 'phi-remote',
    status: 'completed_unread',
    unreadKind: 'completed'
  } as PhiSessionManifest
  const events: StoredSessionEvent[] = []
  let changeCount = 0
  const tracker = new BackgroundAgentApprovalTracker({
    readManifest: (sessionId) => (sessionId === manifest.sessionId ? manifest : null),
    appendEvent: (sessionId, event: SessionEventInput) => ({
      ...event,
      sessionId,
      eventId: String(events.length + 1),
      createdAt: '2026-09-24T00:00:00Z'
    }),
    updateManifest: (_sessionId, patch) => Object.assign(manifest, patch),
    onEvent: (_sessionId, event) => {
      events.push(event)
    },
    onChange: () => {
      changeCount += 1
    }
  })
  return { tracker, manifest, events, changes: () => changeCount }
}

function approval(approvalId: string): BackgroundApprovalRequest {
  return {
    sessionId: 'phi-remote',
    agentRunId: 'wrapper-run-1',
    approvalId,
    toolName: 'edit',
    summary: 'SSH cluster-a · /project\nnote.txt',
    cwd: 'ssh://cluster-a/project'
  }
}

test('background specialist approval is tied to its run, host and Phi timeline', () => {
  const f = fixture()
  f.tracker.requested(approval('approval-1'))
  assert.equal(f.manifest.status, 'needs_approval')
  assert.equal(f.manifest.unreadKind, 'approval')
  assert.equal(f.events[0]?.type, 'approval_requested')
  assert.equal(f.events[0]?.runId, 'wrapper-run-1')
  assert.equal(f.events[0]?.cwd, 'ssh://cluster-a/project')
  f.tracker.resolved('approval-1', 'approved')
  assert.equal(f.events[1]?.type, 'approval_approved')
  assert.equal(f.manifest.status, 'completed_unread')
  assert.equal(f.manifest.unreadKind, 'completed')
  assert.equal(f.changes(), 2)
})

test('multiple approvals keep attention until the last decision, and denial is visible', () => {
  const f = fixture()
  f.tracker.requested(approval('approval-1'))
  f.tracker.requested(approval('approval-2'))
  f.tracker.resolved('approval-1', 'approved')
  assert.equal(f.manifest.status, 'needs_approval')
  f.tracker.resolved('approval-2', 'denied')
  assert.equal(f.manifest.status, 'failed')
  assert.equal(f.manifest.unreadKind, 'failed')
  assert.equal(f.events.at(-1)?.type, 'approval_denied')
})

test('a completed parent turn is not resurrected when a later approval resolves', () => {
  const f = fixture()
  f.tracker.requested(approval('approval-1'))
  f.manifest.status = 'completed_unread'
  f.manifest.unreadKind = 'completed'
  f.tracker.resolved('approval-1', 'approved')
  assert.equal(f.manifest.status, 'completed_unread')
  assert.equal(f.manifest.unreadKind, 'completed')
})

test('pending specialist approval remains visible when the parent run settles', () => {
  const f = fixture()
  f.manifest.status = 'running'
  f.manifest.unreadKind = null
  f.tracker.requested(approval('approval-1'))
  f.manifest.status = 'completed_unread'
  f.manifest.unreadKind = 'completed'
  f.tracker.afterParentRunSettled('phi-remote')
  assert.equal(f.manifest.status, 'needs_approval')
  assert.equal(f.manifest.unreadKind, 'approval')
  f.tracker.resolved('approval-1', 'approved')
  assert.equal(f.manifest.status, 'completed_unread')
  assert.equal(f.manifest.unreadKind, 'completed')
})
