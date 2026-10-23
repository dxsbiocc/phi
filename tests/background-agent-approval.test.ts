import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BackgroundAgentApprovalTracker,
  createBackgroundApprovalRunOriginResolver,
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

test('background specialist approval is tied to its run, host and Phi timeline', async () => {
  const f = fixture()
  f.tracker.requested(approval('approval-1'))
  assert.equal(f.manifest.status, 'needs_approval')
  assert.equal(f.manifest.unreadKind, 'approval')
  assert.equal(f.events[0]?.type, 'approval_requested')
  assert.equal(f.events[0]?.runId, 'wrapper-run-1')
  assert.equal(f.events[0]?.cwd, 'ssh://cluster-a/project')
  await f.tracker.resolved('approval-1', 'approved')
  assert.equal(f.events[1]?.type, 'approval_approved')
  assert.equal(f.manifest.status, 'completed_unread')
  assert.equal(f.manifest.unreadKind, 'completed')
  assert.equal(f.changes(), 2)
})

test('multiple approvals keep attention until the last decision, and denial is visible', async () => {
  const f = fixture()
  f.tracker.requested(approval('approval-1'))
  f.tracker.requested(approval('approval-2'))
  await f.tracker.resolved('approval-1', 'approved')
  assert.equal(f.manifest.status, 'needs_approval')
  await f.tracker.resolved('approval-2', 'denied')
  assert.equal(f.manifest.status, 'failed')
  assert.equal(f.manifest.unreadKind, 'failed')
  assert.equal(f.events.at(-1)?.type, 'approval_denied')
})

test('a completed parent turn is not resurrected when a later approval resolves', async () => {
  const f = fixture()
  f.tracker.requested(approval('approval-1'))
  f.manifest.status = 'completed_unread'
  f.manifest.unreadKind = 'completed'
  await f.tracker.resolved('approval-1', 'approved')
  assert.equal(f.manifest.status, 'completed_unread')
  assert.equal(f.manifest.unreadKind, 'completed')
})

test('pending specialist approval remains visible when the parent run settles', async () => {
  const f = fixture()
  f.manifest.status = 'running'
  f.manifest.unreadKind = null
  f.tracker.requested(approval('approval-1'))
  f.manifest.status = 'completed_unread'
  f.manifest.unreadKind = 'completed'
  f.tracker.afterParentRunSettled('phi-remote')
  assert.equal(f.manifest.status, 'needs_approval')
  assert.equal(f.manifest.unreadKind, 'approval')
  await f.tracker.resolved('approval-1', 'approved')
  assert.equal(f.manifest.status, 'completed_unread')
  assert.equal(f.manifest.unreadKind, 'completed')
})

test('denying a host-origin plan step restores the manifest state from before approval', async () => {
  const f = fixture()
  const tracker = new BackgroundAgentApprovalTracker({
    readManifest: (sessionId) => (sessionId === f.manifest.sessionId ? f.manifest : null),
    resolveRunOrigin: () => 'host',
    appendEvent: (sessionId, event) => ({
      ...event,
      sessionId,
      eventId: 'host-denied',
      createdAt: '2026-09-24T00:00:00Z'
    }),
    updateManifest: (_sessionId, patch) => Object.assign(f.manifest, patch),
    onEvent: () => undefined,
    onChange: () => undefined
  })

  tracker.requested(approval('approval-host'))
  await tracker.resolved('approval-host', 'denied')

  assert.equal(f.manifest.status, 'completed_unread')
  assert.equal(f.manifest.unreadKind, 'completed')
  assert.notEqual(f.manifest.lastRunOutcome, 'failed')
})

test('run-origin resolver binds duplicate run ids to the originating Phi session', async () => {
  const resolve = createBackgroundApprovalRunOriginResolver({
    listRuns: async () => [
      { agentSessionId: 'runtime-other', agentRunId: 'wrapper-run-1', origin: 'tool' },
      { agentSessionId: 'runtime-plan', agentRunId: 'wrapper-run-1', origin: 'host' }
    ],
    resolveSession: (runtimeSessionId) => ({
      phiSessionId: runtimeSessionId === 'runtime-plan' ? 'phi-remote' : 'phi-other'
    })
  })

  assert.equal(await resolve(approval('approval-host')), 'host')
})
