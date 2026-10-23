import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCurrentSessionPayload,
  type CurrentSessionPayloadOperations
} from '../src/main/session-runtime/current-session-payload'

interface PayloadHarness {
  payload: CurrentSessionPayloadOperations
  refreshes: string[]
  setCurrent(next: {
    sessionKey?: string
    sessionPath?: string
    cwd?: string
    permissionMode?: 'auto' | 'ask' | 'full'
    generation?: number
  }): void
  setManifest(next: Record<string, unknown> | null): void
  setProjects(next: {
    cwdProject?: Record<string, unknown>
    manifestProject?: Record<string, unknown>
  }): void
  setRuns(next: {
    promptRun?: { phiSessionId: string }
    activeRun?: Record<string, unknown> | null
  }): void
}

function createPayloadHarness(): PayloadHarness {
  let sessionKey = 'current-key'
  let sessionPath: string | undefined
  let cwd = '/ordinary'
  let permissionMode: 'auto' | 'ask' | 'full' = 'auto'
  let manifest: Record<string, unknown> | null = null
  let cwdProject: Record<string, unknown> | undefined
  let manifestProject: Record<string, unknown> | undefined
  let promptRun: { phiSessionId: string } | undefined
  let activeRun: Record<string, unknown> | null = null
  let generation = 4
  const refreshes: string[] = []

  const payload = createCurrentSessionPayload({
    sessionState: {
      get sessionKey() {
        return sessionKey
      },
      get sessionPath() {
        return sessionPath
      },
      get cwd() {
        return cwd
      },
      get permissionMode() {
        return permissionMode
      },
      refreshPermissionMode: () => {
        refreshes.push(sessionKey)
      }
    },
    sessionKeys: {
      phiSessionIdFor: () => undefined
    },
    lifecycles: {
      forKey: () => ({ currentGeneration: generation }) as never
    },
    promptRuns: {
      activeRun: () => promptRun
    },
    runners: {
      getActiveRun: () => activeRun as never
    },
    sessionResolution: {
      findPhiManifestForSession: () => manifest as never,
      resolveSessionPermissionMode: () => permissionMode
    },
    stores: {
      getProject: () => manifestProject as never,
      getProjectByCwd: () => cwdProject as never
    }
  })

  return {
    payload,
    refreshes,
    setCurrent(next: {
      sessionKey?: string
      sessionPath?: string
      cwd?: string
      permissionMode?: 'auto' | 'ask' | 'full'
      generation?: number
    }) {
      sessionKey = next.sessionKey ?? sessionKey
      sessionPath = next.sessionPath
      cwd = next.cwd ?? cwd
      permissionMode = next.permissionMode ?? permissionMode
      generation = next.generation ?? generation
    },
    setManifest(next: Record<string, unknown> | null) {
      manifest = next
    },
    setProjects(next: {
      cwdProject?: Record<string, unknown>
      manifestProject?: Record<string, unknown>
    }) {
      cwdProject = next.cwdProject
      manifestProject = next.manifestProject
    },
    setRuns(next: {
      promptRun?: { phiSessionId: string }
      activeRun?: Record<string, unknown> | null
    }) {
      promptRun = next.promptRun
      activeRun = next.activeRun ?? null
    }
  }
}

test('getSessionStatusPayload preserves active-run, manifest, and idle status fields', () => {
  const harness = createPayloadHarness()
  harness.setRuns({
    promptRun: { phiSessionId: 'phi-running' },
    activeRun: {
      status: 'needs_approval',
      runId: 'run-1',
      startedAt: '2026-10-21T01:00:00.000Z'
    }
  })
  assert.deepEqual(harness.payload.getSessionStatusPayload('key', '/runtime.jsonl', '/workspace'), {
    status: 'needs_approval',
    unreadKind: 'approval',
    currentRunId: 'run-1',
    currentRunStartedAt: '2026-10-21T01:00:00.000Z'
  })

  harness.setRuns({})
  harness.setManifest({
    status: 'failed',
    unreadKind: 'failed',
    lastRunOutcome: 'failed',
    currentRunId: undefined,
    currentRunStartedAt: undefined,
    lastActivityAt: '2026-10-21T02:00:00.000Z'
  })
  assert.deepEqual(harness.payload.getSessionStatusPayload('key', '/runtime.jsonl', '/workspace'), {
    status: 'failed',
    unreadKind: 'failed',
    lastRunOutcome: 'failed',
    currentRunId: undefined,
    currentRunStartedAt: undefined,
    lastActivityAt: '2026-10-21T02:00:00.000Z'
  })

  harness.setManifest(null)
  assert.deepEqual(harness.payload.getSessionStatusPayload('key', undefined, '/workspace'), {
    status: 'idle',
    unreadKind: null
  })
})

test('getCurrentSessionPayload preserves ordinary, local-project, and remote-project fields', () => {
  const harness = createPayloadHarness()

  assert.deepEqual(harness.payload.getCurrentSessionPayload(), {
    path: null,
    cwd: '/ordinary',
    displayCwd: '/ordinary',
    sessionGeneration: 4,
    permissionMode: 'auto',
    status: 'idle',
    unreadKind: null
  })

  harness.setCurrent({
    sessionPath: '/runtime/local.jsonl',
    cwd: '/projects/local',
    permissionMode: 'ask',
    generation: 5
  })
  harness.setManifest({
    sessionId: 'phi-local',
    projectId: 'project-local',
    status: 'idle',
    unreadKind: null
  })
  harness.setProjects({
    manifestProject: {
      id: 'project-local',
      location: {
        kind: 'local',
        path: '/projects/local',
        realPath: '/projects/local'
      }
    }
  })
  assert.deepEqual(harness.payload.getCurrentSessionPayload(), {
    path: 'phi-session:phi-local',
    phiSessionId: 'phi-local',
    cwd: '/projects/local',
    displayCwd: '/projects/local',
    projectId: 'project-local',
    projectLocation: {
      kind: 'local',
      path: '/projects/local',
      realPath: '/projects/local'
    },
    sessionGeneration: 5,
    permissionMode: 'ask',
    status: 'idle',
    unreadKind: null,
    lastRunOutcome: undefined,
    currentRunId: undefined,
    currentRunStartedAt: undefined,
    lastActivityAt: undefined
  })

  harness.setCurrent({ cwd: '/isolated/remote-anchor', permissionMode: 'full', generation: 6 })
  harness.setManifest({
    sessionId: 'phi-remote',
    projectId: 'project-remote',
    projectLocation: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/cluster/project',
      canonicalRoot: '/cluster/project'
    },
    status: 'completed_unread',
    unreadKind: 'completed',
    lastActivityAt: '2026-10-21T03:00:00.000Z'
  })
  harness.setProjects({})
  assert.deepEqual(harness.payload.getCurrentSessionPayload(), {
    path: 'phi-session:phi-remote',
    phiSessionId: 'phi-remote',
    cwd: '/isolated/remote-anchor',
    displayCwd: '/cluster/project',
    projectId: 'project-remote',
    projectLocation: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/cluster/project',
      canonicalRoot: '/cluster/project'
    },
    legacyRemoteSession: true,
    sessionGeneration: 6,
    permissionMode: 'full',
    status: 'completed_unread',
    unreadKind: 'completed',
    lastRunOutcome: undefined,
    currentRunId: undefined,
    currentRunStartedAt: undefined,
    lastActivityAt: '2026-10-21T03:00:00.000Z'
  })
  harness.setManifest({
    sessionId: 'phi-remote-new',
    projectId: 'project-remote',
    projectLocation: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/cluster/project',
      canonicalRoot: '/cluster/project'
    },
    remoteRuntime: 'rpc',
    status: 'idle',
    unreadKind: null
  })
  assert.equal(harness.payload.getCurrentSessionPayload().legacyRemoteSession, undefined)
  assert.deepEqual(harness.refreshes, ['current-key', 'current-key', 'current-key', 'current-key'])
})
