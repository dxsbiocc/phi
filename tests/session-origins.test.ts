import assert from 'node:assert/strict'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import {
  REMOTE_OMP_VERSION,
  remoteOmpDurableSessionKey,
  type RemoteOmpScope
} from '../src/main/agent/session/runtime-reference'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import { createSessionOrigins } from '../src/main/session-runtime/session-origins'

const remoteScope: RemoteOmpScope = {
  hostProfileId: 'ssh-config:test-host',
  bindingHash: 'a'.repeat(64),
  projectId: 'project-1',
  projectRoot: '/remote/project',
  runtimeRoot: '/remote/runtime'
}

function remoteManifest(overrides: Partial<PhiSessionManifest> = {}): PhiSessionManifest {
  const sessionId = overrides.sessionId ?? 'session-1'
  return {
    schemaVersion: 1,
    sessionId,
    kind: 'project',
    projectId: remoteScope.projectId,
    projectLocation: {
      kind: 'ssh',
      hostProfileId: remoteScope.hostProfileId,
      remoteRoot: remoteScope.projectRoot,
      canonicalRoot: remoteScope.projectRoot
    },
    cwd: remoteScope.projectRoot,
    cwdRealPath: remoteScope.projectRoot,
    runtimeRef: {
      ...remoteScope,
      kind: 'remote-omp',
      version: 1,
      durableSessionKey: remoteOmpDurableSessionKey(remoteScope, sessionId),
      ompSessionId: 'omp-1',
      journalBasename: 'journal.jsonl',
      ompVersion: REMOTE_OMP_VERSION
    },
    permissionMode: 'ask',
    status: 'idle',
    unreadKind: null,
    messageCount: 0,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    lastActivityAt: '2026-10-21T00:00:00.000Z',
    ...overrides
  }
}

function sshProject(): Project {
  return {
    id: remoteScope.projectId,
    name: 'remote',
    location: {
      kind: 'ssh',
      hostProfileId: remoteScope.hostProfileId,
      remoteRoot: remoteScope.projectRoot,
      canonicalRoot: remoteScope.projectRoot
    },
    workingDirectory: remoteScope.projectRoot,
    workingDirectoryRealPath: remoteScope.projectRoot,
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-10-21T00:00:00.000Z'
  }
}

const originServices = {
  findPhiSessionById: () => null,
  getProject: () => undefined,
  resolveRuntimeSessionOrigin: () => undefined,
  resolveRemoteWorkspaceHostBinding: () =>
    ({ canonicalRoot: remoteScope.projectRoot, cacheKey: 'binding' }) as never,
  facadeBindingHash: () => remoteScope.bindingHash
}

test('resolveOriginSession prefers a recorded origin over the active-run fallback', () => {
  const calls: string[] = []
  const origins = createSessionOrigins({
    sessionKeys: {
      originFor: () => {
        calls.push('origin')
        return { sessionKey: 'recorded', cwd: '/recorded' }
      },
      phiSessionIdFor: (sessionKey) => {
        calls.push(`phi:${sessionKey}`)
        return 'phi-recorded'
      }
    },
    findActivePromptRunByRuntimeSessionId: () => {
      calls.push('active-run')
      return { phiSessionId: 'phi-active' }
    },
    getCurrentCwd: () => '/current',
    requireProject: () => {
      throw new Error('not used')
    },
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent'
  })

  assert.deepEqual(origins.resolveOriginSession('runtime-1'), {
    phiSessionId: 'phi-recorded',
    cwd: '/recorded'
  })
  assert.deepEqual(calls, ['origin', 'phi:recorded'])
})

test('resolveOriginSession falls back to the active run and reads cwd at call time', () => {
  let cwd = '/first'
  const origins = createSessionOrigins({
    sessionKeys: {
      originFor: () => undefined,
      phiSessionIdFor: () => {
        throw new Error('not used')
      }
    },
    findActivePromptRunByRuntimeSessionId: (runtimeSessionId) =>
      runtimeSessionId === 'runtime-1' ? { phiSessionId: 'phi-active' } : null,
    getCurrentCwd: () => cwd,
    requireProject: () => {
      throw new Error('not used')
    },
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent'
  })

  assert.deepEqual(origins.resolveOriginSession('runtime-1'), {
    phiSessionId: 'phi-active',
    cwd: '/first'
  })
  cwd = '/second'
  assert.deepEqual(origins.resolveOriginSession('runtime-1'), {
    phiSessionId: 'phi-active',
    cwd: '/second'
  })
})

test('resolveOriginSession returns undefined without an id or a live attribution', () => {
  const origins = createSessionOrigins({
    sessionKeys: { originFor: () => undefined, phiSessionIdFor: () => undefined },
    findActivePromptRunByRuntimeSessionId: () => null,
    getCurrentCwd: () => '/current',
    requireProject: () => {
      throw new Error('not used')
    },
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent'
  })

  assert.equal(origins.resolveOriginSession(undefined), undefined)
  assert.equal(origins.resolveOriginSession('unattributed'), undefined)
})

test('resolveOriginSession does not consult active runs when a recorded origin has no Phi id', () => {
  const calls: string[] = []
  const origins = createSessionOrigins({
    sessionKeys: {
      originFor: () => {
        calls.push('origin')
        return { sessionKey: 'recorded', cwd: '/recorded' }
      },
      phiSessionIdFor: () => {
        calls.push('phi')
        return undefined
      }
    },
    findActivePromptRunByRuntimeSessionId: () => {
      calls.push('active-run')
      return { phiSessionId: 'phi-active' }
    },
    getCurrentCwd: () => '/current',
    requireProject: () => {
      throw new Error('not used')
    },
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent'
  })

  assert.equal(origins.resolveOriginSession('runtime-1'), undefined)
  assert.deepEqual(calls, ['origin', 'phi'])
})

test('currentRuntimeOriginScope returns undefined before project lookup when runtime data is absent', () => {
  const origins = createSessionOrigins({
    sessionKeys: { originFor: () => undefined, phiSessionIdFor: () => undefined },
    findActivePromptRunByRuntimeSessionId: () => null,
    getCurrentCwd: () => '/current',
    requireProject: () => {
      throw new Error('project lookup must not run')
    },
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent'
  })
  const manifest = remoteManifest({ runtimeRef: undefined })

  assert.equal(origins.currentRuntimeOriginScope(manifest), undefined)
})

test('currentRuntimeOriginScope returns undefined for a non-SSH project after parsing the reference', () => {
  const localProject = {
    id: remoteScope.projectId,
    name: 'local',
    location: { kind: 'local', path: '/local/project', realPath: '/local/project' },
    workingDirectory: '/local/project',
    workingDirectoryRealPath: '/local/project',
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-10-21T00:00:00.000Z'
  } as Project
  const origins = createSessionOrigins({
    sessionKeys: { originFor: () => undefined, phiSessionIdFor: () => undefined },
    findActivePromptRunByRuntimeSessionId: () => null,
    getCurrentCwd: () => '/current',
    requireProject: () => localProject,
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent'
  })

  assert.equal(origins.currentRuntimeOriginScope(remoteManifest()), undefined)
})

test('currentRuntimeOriginScope validates and returns the current SSH scope', () => {
  const origins = createSessionOrigins({
    sessionKeys: { originFor: () => undefined, phiSessionIdFor: () => undefined },
    findActivePromptRunByRuntimeSessionId: () => null,
    getCurrentCwd: () => '/current',
    requireProject: () => sshProject(),
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent',
    services: originServices
  })

  assert.deepEqual(origins.currentRuntimeOriginScope(remoteManifest()), remoteScope)
})

test('currentRuntimeOriginScope runs the project assertion before the scope assertion', () => {
  const origins = createSessionOrigins({
    sessionKeys: { originFor: () => undefined, phiSessionIdFor: () => undefined },
    findActivePromptRunByRuntimeSessionId: () => null,
    getCurrentCwd: () => '/current',
    requireProject: () => sshProject(),
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent',
    services: {
      ...originServices,
      resolveRemoteWorkspaceHostBinding: () =>
        ({ canonicalRoot: '/different/project', cacheKey: 'different' }) as never,
      facadeBindingHash: () => 'b'.repeat(64)
    }
  })
  const manifest = remoteManifest()

  assert.throws(
    () => origins.currentRuntimeOriginScope(manifest),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'PROJECT_MISMATCH'
  )
})

test('currentRuntimeOriginScope reaches the scope assertion for a changed binding hash', () => {
  const origins = createSessionOrigins({
    sessionKeys: { originFor: () => undefined, phiSessionIdFor: () => undefined },
    findActivePromptRunByRuntimeSessionId: () => null,
    getCurrentCwd: () => '/current',
    requireProject: () => sshProject(),
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent',
    services: {
      ...originServices,
      facadeBindingHash: () => 'b'.repeat(64)
    }
  })

  assert.throws(
    () => origins.currentRuntimeOriginScope(remoteManifest()),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'HOST_IDENTITY_CHANGED'
  )
})

test('resolveRecoverableJobOrigin stops at a live origin', () => {
  const origins = createSessionOrigins({
    sessionKeys: {
      originFor: () => ({ sessionKey: 'recorded', cwd: '/live' }),
      phiSessionIdFor: () => 'phi-live'
    },
    findActivePromptRunByRuntimeSessionId: () => null,
    getCurrentCwd: () => '/current',
    requireProject: () => sshProject(),
    projectRemoteRuntimeRoot: () => ({ configured: '~/.phi/runtime' }),
    agentDir: '/agent',
    services: {
      ...originServices,
      resolveRuntimeSessionOrigin: () => {
        throw new Error('cold recovery must not run')
      }
    }
  })

  assert.equal(origins.resolveRecoverableJobOrigin(undefined), undefined)
  assert.deepEqual(origins.resolveRecoverableJobOrigin('runtime-1'), {
    phiSessionId: 'phi-live',
    cwd: '/live'
  })
})

test('resolveRecoverableJobOrigin uses the cold record with current remote checks', () => {
  const manifest = remoteManifest()
  const origins = createSessionOrigins({
    sessionKeys: { originFor: () => undefined, phiSessionIdFor: () => undefined },
    findActivePromptRunByRuntimeSessionId: () => null,
    getCurrentCwd: () => '/current',
    requireProject: () => sshProject(),
    projectRemoteRuntimeRoot: () => ({ configured: '/configured/runtime' }),
    agentDir: '/agent',
    services: {
      ...originServices,
      findPhiSessionById: (sessionId) => (sessionId === manifest.sessionId ? manifest : null),
      getProject: (projectId) => (projectId === remoteScope.projectId ? sshProject() : undefined),
      resolveRuntimeSessionOrigin: (runtimeSessionId, options, agentDir) => {
        assert.equal(runtimeSessionId, 'runtime-cold')
        assert.equal(agentDir, '/agent')
        assert.equal(options.readManifest(manifest.sessionId), manifest)
        assert.deepEqual(options.resolveRemoteScope(manifest), remoteScope)
        assert.equal(options.resolveConfiguredRuntimeRoot?.(manifest), '/configured/runtime')
        return { phiSessionId: manifest.sessionId, cwd: manifest.cwd }
      }
    }
  })

  assert.deepEqual(origins.resolveRecoverableJobOrigin('runtime-cold'), {
    phiSessionId: manifest.sessionId,
    cwd: manifest.cwd
  })
})
