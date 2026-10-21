import assert from 'node:assert/strict'
import test from 'node:test'

import type { AnalysisNotebookExecutor } from '../src/main/agent/notebook/analysis-jupyter-execution'
import type {
  RemoteAnalysisNotebookBackend,
  RemoteAnalysisNotebookBackendOptions
} from '../src/main/agent/notebook/remote-analysis-notebook-backend'
import {
  createRemoteNotebookRuntime,
  type RemoteNotebookRuntime,
  type RemoteNotebookRuntimeDeps,
  type RemoteNotebookRuntimeServices
} from '../src/main/agent/notebook/remote-notebook-runtime'
import type { RemoteJupyterStartJobs } from '../src/main/agent/notebook/remote-jupyter-start-jobs'
import type { Project } from '../src/main/agent/projects'
import type { RemoteRuntimeTarget } from '../src/main/agent/remote-runtime/workspace'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'

interface FakeBackend {
  projectCwd: string
  options: RemoteAnalysisNotebookBackendOptions
  disposed: number
  tools: RemoteAnalysisNotebookBackend['tools']
  dispose: () => Promise<void>
}

function localProject(): Project {
  return {
    id: 'local-project',
    name: 'Local project',
    location: { kind: 'local', path: '/projects/local', realPath: '/projects/local' },
    workingDirectory: '/projects/local',
    workingDirectoryRealPath: '/projects/local',
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-10-21T00:00:00.000Z'
  }
}

function remoteProject(id = 'remote-project'): Project {
  return {
    id,
    name: `Remote ${id}`,
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

function remoteManifest(overrides: Partial<PhiSessionManifest> = {}): PhiSessionManifest {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    kind: 'project',
    projectId: 'remote-project',
    cwd: '/agent/anchors/remote-project',
    cwdRealPath: '/agent/anchors/remote-project',
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

function fakeBackend(options: RemoteAnalysisNotebookBackendOptions): FakeBackend {
  const backend: FakeBackend = {
    projectCwd: options.projectCwd,
    options,
    disposed: 0,
    tools: {
      execute: async () => ({ content: [] })
    } as unknown as RemoteAnalysisNotebookBackend['tools'],
    dispose: async () => {
      backend.disposed += 1
    }
  }
  return backend
}

function createServices(
  created: FakeBackend[],
  overrides: Partial<RemoteNotebookRuntimeServices> = {}
): RemoteNotebookRuntimeServices {
  const defaults: RemoteNotebookRuntimeServices = {
    createRemoteAnalysisNotebookBackend: ((options) => {
      const backend = fakeBackend(options)
      created.push(backend)
      return backend as unknown as RemoteAnalysisNotebookBackend
    }) as RemoteNotebookRuntimeServices['createRemoteAnalysisNotebookBackend'],
    findPhiSessionById: () => null,
    getProject: () => undefined,
    openRemoteRuntimeWorkspace:
      (async () => ({})) as unknown as RemoteNotebookRuntimeServices['openRemoteRuntimeWorkspace'],
    readHostRemoteEnvironmentPaths: () => ({}),
    remoteMicromambaManifestVersion: () => '2.0.0',
    remoteProjectAnchorPath: (projectId, agentDir) => `${agentDir}/anchors/${projectId}`,
    resolveAuthorizedRemoteConnectionConfig: (() => ({
      sessionId: 'session-1',
      projectId: 'remote-project',
      hostAlias: 'cluster',
      connection: {}
    })) as unknown as RemoteNotebookRuntimeServices['resolveAuthorizedRemoteConnectionConfig'],
    resolveRemoteBaseEnvironment: (async () => ({
      packages: [],
      channels: []
    })) as unknown as RemoteNotebookRuntimeServices['resolveRemoteBaseEnvironment'],
    resolveRemoteWorkspaceHostBinding: ((input: { sessionId: string; projectId: string }) => ({
      sessionId: input.sessionId,
      projectId: input.projectId,
      hostAlias: 'cluster',
      remoteRoot: '/remote/project',
      canonicalRoot: `/canonical/${input.projectId}`,
      cacheKey: `binding:${input.projectId}`,
      config: {}
    })) as unknown as RemoteNotebookRuntimeServices['resolveRemoteWorkspaceHostBinding']
  }
  return { ...defaults, ...overrides }
}

function createRuntime(
  services: RemoteNotebookRuntimeServices,
  overrides: Partial<RemoteNotebookRuntimeDeps> = {}
): RemoteNotebookRuntime {
  return createRemoteNotebookRuntime({
    agentDir: '/agent',
    projectRemoteRuntimeRoot: () => ({
      source: 'project',
      configured: '/configured/remote-project'
    }),
    sessionKeys: { originFor: () => undefined, phiSessionIdFor: () => undefined },
    notebookExecutor: {} as AnalysisNotebookExecutor,
    startJobs: {} as RemoteJupyterStartJobs,
    onDraftChanged: () => undefined,
    services,
    ...overrides
  })
}

test('remote notebook target rejects local projects and builds the ssh target', async () => {
  const opened: RemoteRuntimeTarget[] = []
  const created: FakeBackend[] = []
  const runtime = createRuntime(
    createServices(created, {
      openRemoteRuntimeWorkspace: (async (target: RemoteRuntimeTarget) => {
        opened.push(target)
        return {}
      }) as unknown as RemoteNotebookRuntimeServices['openRemoteRuntimeWorkspace'],
      readHostRemoteEnvironmentPaths: () => ({
        jupyter: '/opt/jupyter',
        micromamba: '/opt/micromamba'
      })
    })
  )

  assert.throws(
    () => runtime.remoteNotebookBackend(localProject(), 'session-local'),
    /远程 Notebook 项目位置无效/
  )

  const project = remoteProject()
  const backend = runtime.remoteNotebookBackend(project, 'session-1') as unknown as FakeBackend
  await backend.options.openWorkspace('notebook:remote-project', new AbortController().signal)

  assert.deepEqual(opened, [
    {
      runtimeSessionId: 'notebook:remote-project',
      sessionId: 'session-1',
      projectId: 'remote-project',
      configuredRoot: '/configured/remote-project',
      micromambaPath: '/opt/micromamba'
    }
  ])
})

test('remote notebook target omits an unset micromamba path', async () => {
  const opened: RemoteRuntimeTarget[] = []
  const created: FakeBackend[] = []
  const runtime = createRuntime(
    createServices(created, {
      openRemoteRuntimeWorkspace: (async (target: RemoteRuntimeTarget) => {
        opened.push(target)
        return {}
      }) as unknown as RemoteNotebookRuntimeServices['openRemoteRuntimeWorkspace']
    })
  )

  const backend = runtime.remoteNotebookBackend(
    remoteProject(),
    'session-1'
  ) as unknown as FakeBackend
  await backend.options.openWorkspace('notebook:remote-project', new AbortController().signal)

  assert.equal(opened.length, 1)
  assert.equal('micromambaPath' in opened[0], false)
})

test('configured Jupyter path is read at start time, not at backend creation', () => {
  const created: FakeBackend[] = []
  let jupyter = '/first/jupyter'
  const runtime = createRuntime(
    createServices(created, {
      readHostRemoteEnvironmentPaths: () => ({ jupyter })
    })
  )

  const backend = runtime.remoteNotebookBackend(
    remoteProject(),
    'session-1'
  ) as unknown as FakeBackend

  jupyter = '/second/jupyter'
  assert.equal(backend.options.configuredJupyterPath?.(), '/second/jupyter')
  jupyter = '/third/jupyter'
  assert.equal(backend.options.configuredJupyterPath?.(), '/third/jupyter')
})

test('remote notebook runtime checks the workspace identity and released session', async () => {
  const created: FakeBackend[] = []
  const runtime = createRuntime(createServices(created))
  const backend = runtime.remoteNotebookBackend(
    remoteProject(),
    'session-1'
  ) as unknown as FakeBackend

  assert.throws(
    () => backend.options.openWorkspace('notebook:other-project', new AbortController().signal),
    /远程 Notebook runtime 身份无效/
  )

  runtime.remoteNotebookSessionIds.clear()
  assert.throws(
    () => backend.options.openWorkspace('notebook:remote-project', new AbortController().signal),
    /远程 Notebook 会话已释放/
  )
})

test('backend cache reuses one backend per project and tracks the active session', () => {
  const created: FakeBackend[] = []
  const runtime = createRuntime(createServices(created))
  const project = remoteProject()

  const first = runtime.remoteNotebookBackend(project, 'session-1') as unknown as FakeBackend
  const cached = runtime.remoteNotebookBackend(project, 'session-2') as unknown as FakeBackend

  assert.equal(cached, first)
  assert.equal(created.length, 1)
  assert.equal(first.projectCwd, '/canonical/remote-project')
  assert.equal(first.options.runtimeSessionId, 'notebook:remote-project')
  assert.equal(runtime.remoteNotebookSessionIds.get(project.id), 'session-2')

  runtime.remoteNotebookBackend(project, 'session-3')
  assert.equal(runtime.remoteNotebookSessionIds.get(project.id), 'session-3')

  const other = runtime.remoteNotebookBackend(remoteProject('other-project'), 'session-other')
  assert.notEqual(other, first as unknown as RemoteAnalysisNotebookBackend)
  assert.equal(created.length, 2)
  assert.equal(runtime.remoteNotebookSessionIds.get('other-project'), 'session-other')
})

test('resolveRemoteNotebookToolBackend returns null for every unverified identity', async () => {
  const created: FakeBackend[] = []
  let manifest: PhiSessionManifest | null = remoteManifest()
  let project: Project | undefined = remoteProject()
  let origin: { sessionKey: string; cwd: string } | undefined = {
    sessionKey: 'key',
    cwd: '/agent/anchors/remote-project'
  }
  const phiSessionIds = new Map([['key', 'session-1']])
  const runtime = createRuntime(
    createServices(created, {
      findPhiSessionById: () => manifest,
      getProject: () => project
    }),
    {
      sessionKeys: {
        originFor: () => origin,
        phiSessionIdFor: (key) => phiSessionIds.get(key)
      }
    }
  )
  const identity = {
    runtimeSessionId: 'notebook:remote-project',
    sessionId: 'session-1',
    projectId: 'remote-project'
  }

  manifest = null
  assert.equal(await runtime.resolveRemoteNotebookToolBackend(identity), null)
  manifest = remoteManifest()

  project = undefined
  assert.equal(await runtime.resolveRemoteNotebookToolBackend(identity), null)
  project = remoteProject()

  origin = undefined
  assert.equal(await runtime.resolveRemoteNotebookToolBackend(identity), null)
  origin = { sessionKey: 'key', cwd: '/agent/anchors/remote-project' }

  project = localProject()
  assert.equal(await runtime.resolveRemoteNotebookToolBackend(identity), null)
  project = remoteProject()

  manifest = remoteManifest({ projectId: 'other-project' })
  assert.equal(await runtime.resolveRemoteNotebookToolBackend(identity), null)
  manifest = remoteManifest()

  phiSessionIds.set('key', 'other-session')
  assert.equal(await runtime.resolveRemoteNotebookToolBackend(identity), null)
  phiSessionIds.set('key', 'session-1')

  origin = { sessionKey: 'key', cwd: '/elsewhere' }
  assert.equal(await runtime.resolveRemoteNotebookToolBackend(identity), null)
  origin = { sessionKey: 'key', cwd: '/agent/anchors/remote-project' }

  manifest = remoteManifest({ cwd: '/agent/anchors/other-project' })
  assert.equal(await runtime.resolveRemoteNotebookToolBackend(identity), null)
  manifest = remoteManifest()

  assert.equal(created.length, 0)
})

test('resolveRemoteNotebookToolBackend returns the cached remote backend for the verified identity', async () => {
  const created: FakeBackend[] = []
  const runtime = createRuntime(
    createServices(created, {
      findPhiSessionById: () => remoteManifest(),
      getProject: () => remoteProject()
    }),
    {
      sessionKeys: {
        originFor: () => ({ sessionKey: 'key', cwd: '/agent/anchors/remote-project' }),
        phiSessionIdFor: () => 'session-1'
      }
    }
  )

  const resolved = await runtime.resolveRemoteNotebookToolBackend({
    runtimeSessionId: 'notebook:remote-project',
    sessionId: 'session-1',
    projectId: 'remote-project'
  })

  assert.ok(resolved)
  assert.equal(resolved.projectCwd, '/canonical/remote-project')
  assert.equal(created.length, 1)
  assert.equal(runtime.remoteNotebookSessionIds.get('remote-project'), 'session-1')
  assert.deepEqual(await (resolved.execute as unknown as () => Promise<unknown>)(), { content: [] })
})

test('disposal disposes every backend and clears both maps', async () => {
  const created: FakeBackend[] = []
  const runtime = createRuntime(createServices(created))
  const first = runtime.remoteNotebookBackend(remoteProject('project-a'), 'session-a')
  const second = runtime.remoteNotebookBackend(remoteProject('project-b'), 'session-b')

  assert.equal(runtime.remoteNotebookSessionIds.size, 2)

  await runtime.disposeRemoteNotebookBackends()

  assert.deepEqual(
    created.map((backend) => backend.disposed),
    [1, 1]
  )
  assert.equal(runtime.remoteNotebookSessionIds.size, 0)

  const recreated = runtime.remoteNotebookBackend(remoteProject('project-a'), 'session-c')
  assert.notEqual(recreated, first)
  assert.notEqual(recreated, second)
  assert.equal(created.length, 3)
  assert.equal(created[2].disposed, 0)
  assert.equal(runtime.remoteNotebookSessionIds.get('project-a'), 'session-c')
})

test('disposing one project backend leaves the other registration intact', async () => {
  const created: FakeBackend[] = []
  const runtime = createRuntime(createServices(created))
  runtime.remoteNotebookBackend(remoteProject('project-a'), 'session-a')
  runtime.remoteNotebookBackend(remoteProject('project-b'), 'session-b')

  await runtime.disposeRemoteNotebookBackend('project-a')

  assert.equal(created[0].disposed, 1)
  assert.equal(created[1].disposed, 0)
  assert.equal(runtime.remoteNotebookSessionIds.has('project-a'), false)
  assert.equal(runtime.remoteNotebookSessionIds.get('project-b'), 'session-b')
})
