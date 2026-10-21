import assert from 'node:assert/strict'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import { createAnalysisWorkspaceResolution } from '../src/main/agent/notebook/analysis-workspace-resolution'
import { createNotebookServerReadiness } from '../src/main/agent/notebook/notebook-server-readiness'
import { createRemoteNotebookBackendDisposal } from '../src/main/agent/notebook/remote-notebook-backend-disposal'

function localProject(): Project {
  return {
    id: 'local-project',
    name: 'Local project',
    location: {
      kind: 'local',
      path: '/projects/local',
      realPath: '/projects/local'
    },
    workingDirectory: '/projects/local',
    workingDirectoryRealPath: '/projects/local',
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-10-21T00:00:00.000Z'
  }
}

function remoteProject(): Project & {
  location: Extract<Project['location'], { kind: 'ssh' }>
} {
  return {
    id: 'remote-project',
    name: 'Remote project',
    location: {
      kind: 'ssh',
      hostProfileId: 'ssh-config:cluster',
      remoteRoot: '/remote/project',
      canonicalRoot: '/canonical/project'
    },
    workingDirectory: '/remote/project',
    workingDirectoryRealPath: '/remote/project',
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-10-21T00:00:00.000Z'
  }
}

test('analysis workspace resolution returns the registered local project', () => {
  const project = localProject()
  const assertedPaths: string[] = []
  const resolution = createAnalysisWorkspaceResolution({
    agentDir: '/agent',
    getCurrentSessionCwd: () => '/session',
    currentRemoteAnalysisProject: () => null,
    getNoProjectTaskFolder: () => '/tasks',
    realDirectoryPath: (path) => path,
    services: {
      assertProjectPathAvailable: (path) => assertedPaths.push(path),
      getProjectByCwd: (cwd) => (cwd === project.workingDirectory ? project : undefined),
      listProjects: () => [project],
      isRemoteProjectAnchorPath: () => false,
      isPathInsideRoot: () => false
    }
  })

  assert.deepEqual(resolution.resolveAnalysisWorkspaceByCwd('/projects/local'), {
    workingDirectory: '/projects/local',
    name: 'Local project',
    project
  })
  assert.deepEqual(assertedPaths, ['/projects/local'])
  assert.equal(resolution.isRemoteAnalysisCwd('/projects/local'), false)
})

test('analysis workspace resolution preserves the active remote session identity', () => {
  const project = remoteProject()
  const resolution = createAnalysisWorkspaceResolution({
    agentDir: '/agent',
    getCurrentSessionCwd: () => '/session',
    currentRemoteAnalysisProject: (cwd) =>
      cwd === project.location.remoteRoot ? { project, sessionId: 'session-remote' } : null,
    getNoProjectTaskFolder: () => '/tasks',
    realDirectoryPath: () => null,
    services: {
      assertProjectPathAvailable: () => undefined,
      getProjectByCwd: () => undefined,
      listProjects: () => [project],
      isRemoteProjectAnchorPath: () => false,
      isPathInsideRoot: (root, cwd) => cwd.startsWith(`${root}/`)
    }
  })

  assert.deepEqual(resolution.resolveAnalysisWorkspaceByCwd('/remote/project'), {
    workingDirectory: '/canonical/project',
    name: 'Remote project',
    project,
    remoteSessionId: 'session-remote'
  })
  assert.equal(resolution.isRemoteAnalysisCwd('/remote/project'), true)
  assert.equal(resolution.isRemoteAnalysisCwd('/canonical/project/notebooks'), true)
})

test('notebook server readiness starts and waits for an endpoint', async () => {
  const calls: string[] = []
  const statuses = [
    { projectCwd: '/project', state: 'stopped' as const, hasEndpoint: false },
    { projectCwd: '/project', state: 'starting' as const, hasEndpoint: false },
    { projectCwd: '/project', state: 'ready' as const, hasEndpoint: true }
  ]
  const readiness = createNotebookServerReadiness({
    jupyterServerRegistry: {
      status: (cwd) => {
        calls.push(`status:${cwd}`)
        return (
          statuses.shift() ?? {
            projectCwd: cwd,
            state: 'ready' as const,
            hasEndpoint: true
          }
        )
      },
      start: (cwd) => {
        calls.push(`start:${cwd}`)
        return { projectCwd: cwd, state: 'starting', hasEndpoint: false }
      }
    },
    delay: async (ms) => {
      calls.push(`delay:${ms}`)
    }
  })

  await readiness.ensureJupyterServerReady('/project')

  assert.deepEqual(calls, [
    'status:/project',
    'start:/project',
    'delay:250',
    'status:/project',
    'delay:250',
    'status:/project'
  ])
})

test('notebook server readiness reports a terminal startup error', async () => {
  const readiness = createNotebookServerReadiness({
    jupyterServerRegistry: {
      status: (cwd) => ({ projectCwd: cwd, state: 'stopped', hasEndpoint: false }),
      start: (cwd) => ({
        projectCwd: cwd,
        state: 'error',
        hasEndpoint: false,
        message: 'launch failed'
      })
    },
    delay: async () => {
      assert.fail('terminal states must not wait')
    }
  })

  await assert.rejects(readiness.ensureJupyterServerReady('/project'), /launch failed/)
})

test('remote notebook backend disposal awaits cleanup before deleting registrations', async () => {
  let finishDisposal: (() => void) | undefined
  const disposed = new Promise<void>((resolve) => {
    finishDisposal = resolve
  })
  const backends = new Map([
    [
      'remote-project',
      {
        dispose: () => disposed
      }
    ]
  ])
  const sessionIds = new Map([['remote-project', 'session-remote']])
  const disposal = createRemoteNotebookBackendDisposal({
    remoteNotebookBackends: backends,
    remoteNotebookSessionIds: sessionIds
  })

  const pending = disposal.disposeRemoteNotebookBackend('remote-project')
  assert.equal(backends.has('remote-project'), true)
  assert.equal(sessionIds.has('remote-project'), true)

  finishDisposal?.()
  await pending

  assert.equal(backends.has('remote-project'), false)
  assert.equal(sessionIds.has('remote-project'), false)
})

test('remote notebook backend disposal ignores projects without a backend', async () => {
  const backends = new Map<string, { dispose: () => Promise<void> }>()
  const sessionIds = new Map([['missing-project', 'stale-session']])
  const disposal = createRemoteNotebookBackendDisposal({
    remoteNotebookBackends: backends,
    remoteNotebookSessionIds: sessionIds
  })

  await disposal.disposeRemoteNotebookBackend('missing-project')

  assert.equal(sessionIds.get('missing-project'), 'stale-session')
})
