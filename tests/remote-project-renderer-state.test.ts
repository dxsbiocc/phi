import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

import { createCurrentSessionPayload } from '../src/main/session-runtime/current-session-payload'
import { sessionRuntimeStateIsBusy } from '../src/renderer/src/lib/sessionRuntimeState'
import { sessionDraftKey } from '../src/renderer/src/lib/sessionDrafts'
import {
  sessionAgentEventStates,
  sessionRuntimeStates,
  useSessionStore
} from '../src/renderer/src/stores/sessionStore'
import type { CurrentSession } from '../src/renderer/src/types'

const location = {
  kind: 'ssh' as const,
  hostProfileId: 'host-a',
  remoteRoot: '/cluster/work',
  canonicalRoot: '/data/work'
}

function current(overrides: Partial<CurrentSession> = {}): CurrentSession {
  return {
    path: 'phi-session:remote-session-1',
    phiSessionId: 'remote-session-1',
    cwd: '/home/user/.phi/remote-project-anchors/project-a',
    displayCwd: '/cluster/work',
    projectId: 'project-a',
    projectLocation: location,
    sessionGeneration: 1,
    permissionMode: 'ask',
    status: 'idle',
    unreadKind: null,
    ...overrides
  }
}

function remoteMainSnapshot(
  input: {
    promptRun?: { runId: string; cancelled?: boolean }
    activeRun?: {
      status: 'running' | 'needs_approval' | 'needs_input'
      runId: string
      startedAt: string
    }
    manifest?: Partial<CurrentSession>
  } = {}
): CurrentSession {
  const remote = current()
  return createCurrentSessionPayload({
    sessionState: {
      sessionKey: 'phi:remote-session-1',
      sessionPath: remote.path ?? undefined,
      cwd: remote.cwd,
      permissionMode: remote.permissionMode,
      refreshPermissionMode: () => undefined
    },
    sessionKeys: {
      phiSessionIdFor: () => remote.phiSessionId
    },
    lifecycles: {
      forKey: () => ({ currentGeneration: remote.sessionGeneration }) as never
    },
    promptRuns: {
      activeRun: () =>
        input.promptRun
          ? {
              phiSessionId: remote.phiSessionId as string,
              runId: input.promptRun.runId,
              cancelled: input.promptRun.cancelled ?? false
            }
          : undefined
    },
    runners: {
      getActiveRun: () => (input.activeRun ?? null) as never
    },
    sessionResolution: {
      findPhiManifestForSession: () =>
        ({
          sessionId: remote.phiSessionId,
          projectId: remote.projectId,
          projectLocation: remote.projectLocation,
          remoteRuntime: 'rpc',
          status: 'idle',
          unreadKind: null,
          ...input.manifest
        }) as never,
      resolveSessionPermissionMode: () => remote.permissionMode
    },
    stores: {
      getProject: () => ({ id: remote.projectId, location: remote.projectLocation }) as never,
      getProjectByCwd: () => undefined
    }
  }).getCurrentSessionPayload()
}

beforeEach(() => {
  sessionAgentEventStates.clear()
  sessionRuntimeStates.clear()
})

test('renderer keeps private runtime cwd separate from the visible SSH project path', () => {
  const store = useSessionStore.getState()
  store.applyCurrentSession(current())
  const remote = useSessionStore.getState()
  assert.equal(remote.activeCwd, '/home/user/.phi/remote-project-anchors/project-a')
  assert.equal(remote.activeDisplayCwd, '/cluster/work')
  assert.equal(remote.activeProjectId, 'project-a')
  assert.deepEqual(remote.activeProjectLocation, location)

  const draftKey = sessionDraftKey({
    phiSessionId: remote.activePhiSessionId,
    path: remote.activeSessionPath,
    cwd: remote.activeCwd,
    sessionGeneration: remote.activeSessionGeneration
  })
  remote.setDraftInputs({ [draftKey]: 'unsent text while SSH is offline' })
  remote.applyCurrentSession(
    current({
      path: 'phi-session:ordinary-1',
      phiSessionId: 'ordinary-1',
      cwd: '/workspace',
      displayCwd: '/workspace',
      projectId: undefined,
      projectLocation: undefined,
      permissionMode: 'auto'
    })
  )
  assert.equal(useSessionStore.getState().activeProjectId, null)
  remote.applyCurrentSession(current({ sessionGeneration: 2 }))
  const restored = useSessionStore.getState()
  assert.equal(restored.activeDisplayCwd, '/cluster/work')
  assert.equal(restored.draftInputs[draftKey], 'unsent text while SSH is offline')
})

test('reopening a remote chat keeps its indicator during pre-runtime connection work', () => {
  const remote = current()
  const store = useSessionStore.getState()
  store.applyCurrentSession(remote)
  store.applyCurrentSession(
    current({
      path: 'phi-session:ordinary-1',
      phiSessionId: 'ordinary-1',
      cwd: '/workspace',
      displayCwd: '/workspace',
      projectId: undefined,
      projectLocation: undefined,
      permissionMode: 'auto'
    })
  )

  const mainSnapshot = remoteMainSnapshot({ promptRun: { runId: 'run-connecting' } })

  useSessionStore.getState().applyCurrentSession(mainSnapshot)

  const reopened = useSessionStore.getState()
  assert.equal(reopened.activePhiSessionId, 'remote-session-1')
  assert.equal(reopened.activeSessionRuntimeState.currentRunId, 'run-connecting')
  assert.equal(sessionRuntimeStateIsBusy(reopened.activeSessionRuntimeState), true)
})

test('reopening during streaming or tool execution stays busy, then completion clears it', () => {
  const runningSnapshot = remoteMainSnapshot({
    promptRun: { runId: 'run-active' },
    activeRun: {
      status: 'running',
      runId: 'run-active',
      startedAt: '2026-10-30T10:00:00.000Z'
    }
  })
  useSessionStore.getState().applyCurrentSession(runningSnapshot)
  assert.equal(
    sessionRuntimeStateIsBusy(useSessionStore.getState().activeSessionRuntimeState),
    true
  )

  useSessionStore.getState().applyCurrentSession(
    current({
      path: 'phi-session:ordinary-1',
      phiSessionId: 'ordinary-1',
      cwd: '/workspace',
      displayCwd: '/workspace',
      projectId: undefined,
      projectLocation: undefined,
      permissionMode: 'auto'
    })
  )
  useSessionStore.getState().applyCurrentSession(
    remoteMainSnapshot({
      manifest: {
        status: 'completed_unread',
        unreadKind: 'completed',
        lastRunOutcome: 'completed',
        currentRunId: undefined,
        currentRunStartedAt: undefined
      }
    })
  )

  const completed = useSessionStore.getState().activeSessionRuntimeState
  assert.equal(sessionRuntimeStateIsBusy(completed), false)
  assert.equal(completed.status, 'completed_unread')
  assert.equal(completed.currentRunId, undefined)
})
