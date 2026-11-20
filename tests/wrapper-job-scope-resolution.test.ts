import assert from 'node:assert/strict'
import test from 'node:test'

import type { WrapperRun } from '../src/main/agent/wrappers/types'
import { wrapperJobHostHandlers } from '../src/main/agent/wrappers/composition/job-host-handlers'
import type { WrapperJobClient } from '../src/main/agent/wrappers/composition/job-types'
import { remoteProjectAnchorPath } from '../src/main/agent/remote-project-anchor'
import type { Project } from '../src/main/agent/projects'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import {
  resolveWrapperJobHostScope,
  type WrapperJobScopeDependencies
} from '../src/main/agent/wrappers/composition/job-host-scope'

const remoteProject = {
  id: 'project',
  name: 'Project',
  location: {
    kind: 'ssh',
    hostProfileId: 'host-profile',
    remoteRoot: '/remote/project',
    canonicalRoot: '/canonical/project'
  }
} as Project

const localProject = {
  ...remoteProject,
  location: { kind: 'local', path: '/local/project', realPath: '/local/project' }
} as Project

const remoteManifest = {
  sessionId: 'phi-session',
  projectId: remoteProject.id,
  projectLocation: remoteProject.location
} as PhiSessionManifest

function fixture(): {
  calls: string[]
  controller: AbortController
  dependencies: WrapperJobScopeDependencies
  setOrigin(value: { phiSessionId: string; cwd: string } | undefined): void
  setManifest(value: PhiSessionManifest | null): void
  setProject(value: Project | undefined): void
  setOwned(value: boolean): void
  setBindingKey(value: string): void
  setTargetHost(value: string): void
  setTargetError(value: string | undefined): void
} {
  const calls: string[] = []
  const controller = new AbortController()
  let origin: { phiSessionId: string; cwd: string } | undefined = {
    phiSessionId: remoteManifest.sessionId,
    cwd: '/remote/project'
  }
  let manifest: PhiSessionManifest | null = remoteManifest
  let project: Project | undefined = remoteProject
  let owned = false
  let bindingKey = 'binding'
  let targetHost = 'cluster'
  let targetError: string | undefined
  const dependencies: WrapperJobScopeDependencies = {
    resolveOrigin: (originSessionId) => {
      calls.push(`origin:${originSessionId}`)
      return origin
    },
    findSession: (sessionId) => {
      calls.push(`session:${sessionId}`)
      return manifest
    },
    getProject: (projectId) => {
      calls.push(`project:${projectId}`)
      return project
    },
    ownsRemoteRuntimeSession: (originSessionId) => {
      calls.push(`owned:${originSessionId}`)
      return owned
    },
    resolveBinding: ({ sessionId, projectId }) => {
      calls.push(`binding:${sessionId}:${projectId}`)
      return { cacheKey: bindingKey }
    },
    resolveTarget: (selectedProject) => {
      calls.push(`target:${selectedProject.id}`)
      if (targetError) return { reason: targetError }
      return {
        target: {
          connection: { host: targetHost },
          workspaceRoot: '/canonical/project'
        },
        connectionId: 'host-profile',
        projectId: selectedProject.id,
        hostProfileId: 'host-profile'
      }
    },
    readRun: () => undefined
  }
  return {
    calls,
    controller,
    dependencies,
    setOrigin: (value) => {
      origin = value
    },
    setManifest: (value) => {
      manifest = value
    },
    setProject: (value) => {
      project = value
    },
    setOwned: (value) => {
      owned = value
    },
    setBindingKey: (value) => {
      bindingKey = value
    },
    setTargetHost: (value) => {
      targetHost = value
    },
    setTargetError: (value) => {
      targetError = value
    }
  }
}

test('Wrapper scope keeps unscoped desktop calls and rejects signal-bearing calls without an origin', () => {
  const f = fixture()
  assert.equal(resolveWrapperJobHostScope(undefined, f.dependencies), undefined)
  assert.deepEqual(f.calls, [])
  assert.throws(
    () => resolveWrapperJobHostScope({ signal: f.controller.signal }, f.dependencies),
    /no trusted origin/
  )
  assert.deepEqual(f.calls, [])
})

test('Wrapper scope rejects missing origins and manifests in the original lookup order', () => {
  const missingOrigin = fixture()
  missingOrigin.setOrigin(undefined)
  assert.throws(
    () =>
      resolveWrapperJobHostScope(
        { originSessionId: 'runtime-session' },
        missingOrigin.dependencies
      ),
    /origin session is unavailable/
  )
  assert.deepEqual(missingOrigin.calls, ['origin:runtime-session'])

  const missingManifest = fixture()
  missingManifest.setManifest(null)
  assert.throws(
    () =>
      resolveWrapperJobHostScope(
        { originSessionId: 'runtime-session' },
        missingManifest.dependencies
      ),
    /origin session is unavailable/
  )
  assert.deepEqual(missingManifest.calls, ['origin:runtime-session', 'session:phi-session'])
})

test('Wrapper scope permits plain local calls but rejects RPC or remote-manifest project mismatches', () => {
  const local = fixture()
  local.setProject(localProject)
  local.setManifest({ ...remoteManifest, projectLocation: localProject.location })
  assert.equal(
    resolveWrapperJobHostScope({ originSessionId: 'runtime-session' }, local.dependencies),
    undefined
  )
  assert.deepEqual(local.calls, [
    'origin:runtime-session',
    'session:phi-session',
    'project:project'
  ])

  const rpc = fixture()
  rpc.setProject(localProject)
  assert.throws(
    () =>
      resolveWrapperJobHostScope(
        { originSessionId: 'runtime-session', signal: rpc.controller.signal },
        rpc.dependencies
      ),
    /RPC Wrapper project is unavailable/
  )

  const staleRemote = fixture()
  staleRemote.setProject(undefined)
  assert.throws(
    () =>
      resolveWrapperJobHostScope({ originSessionId: 'runtime-session' }, staleRemote.dependencies),
    /RPC Wrapper project is unavailable/
  )

  const missingProjectId = fixture()
  missingProjectId.setManifest({ ...remoteManifest, projectId: null })
  assert.throws(
    () =>
      resolveWrapperJobHostScope(
        { originSessionId: 'runtime-session' },
        missingProjectId.dependencies
      ),
    /RPC Wrapper project is unavailable/
  )
  assert.deepEqual(missingProjectId.calls, ['origin:runtime-session', 'session:phi-session'])
})

test('owned RPC Wrapper calls require a cancellation scope before binding resolution', () => {
  const f = fixture()
  f.setOwned(true)
  assert.throws(
    () => resolveWrapperJobHostScope({ originSessionId: 'runtime-session' }, f.dependencies),
    /no owned cancellation scope/
  )
  assert.deepEqual(f.calls, [
    'origin:runtime-session',
    'session:phi-session',
    'project:project',
    'owned:runtime-session'
  ])

  const signalled = fixture()
  signalled.setOwned(true)
  assert.ok(
    resolveWrapperJobHostScope(
      { originSessionId: 'runtime-session', signal: signalled.controller.signal },
      signalled.dependencies
    )
  )
})

test('Wrapper scope resolves the binding before the target and relays target errors', () => {
  const f = fixture()
  f.setTargetError('target unavailable')
  assert.throws(
    () =>
      resolveWrapperJobHostScope(
        { originSessionId: 'runtime-session', signal: f.controller.signal },
        f.dependencies
      ),
    /target unavailable/
  )
  assert.deepEqual(f.calls.slice(-2), ['binding:phi-session:project', 'target:project'])
})

test('Wrapper scope snapshots the remote identity and rechecks each binding component in order', () => {
  const stable = fixture()
  const scope = resolveWrapperJobHostScope(
    { originSessionId: 'runtime-session', signal: stable.controller.signal },
    stable.dependencies
  )
  assert.ok(scope)
  assert.equal(scope.executionHost, 'ssh')
  assert.equal(scope.originSessionId, 'runtime-session')
  assert.equal(scope.signal, stable.controller.signal)
  const assertStableScopeCurrent = scope.assertCurrent
  assert.ok(assertStableScopeCurrent)
  stable.calls.length = 0
  assertStableScopeCurrent()
  assert.deepEqual(stable.calls, [
    'project:project',
    'origin:runtime-session',
    'binding:phi-session:project',
    'target:project'
  ])

  for (const change of [
    (f: ReturnType<typeof fixture>): void => f.setProject(undefined),
    (f: ReturnType<typeof fixture>): void => f.setOrigin({ phiSessionId: 'other', cwd: '/' }),
    (f: ReturnType<typeof fixture>): void => f.setBindingKey('other-binding'),
    (f: ReturnType<typeof fixture>): void => f.setTargetHost('other-cluster')
  ]) {
    const changed = fixture()
    const changedScope = resolveWrapperJobHostScope(
      { originSessionId: 'runtime-session', signal: changed.controller.signal },
      changed.dependencies
    )
    assert.ok(changedScope)
    const assertChangedScopeCurrent = changedScope.assertCurrent
    assert.ok(assertChangedScopeCurrent)
    change(changed)
    assert.throws(assertChangedScopeCurrent, /selected project\/host binding changed/)
  }
})

const localManifest: PhiSessionManifest = {
  ...remoteManifest,
  kind: 'project',
  projectLocation: localProject.location,
  cwd: '/local/project',
  cwdRealPath: '/local/project'
}
const ordinaryManifest: PhiSessionManifest = {
  ...localManifest,
  kind: 'ordinary',
  projectId: null,
  projectLocation: undefined,
  cwd: '/local/workspace',
  cwdRealPath: '/local/workspace'
}

function localFixture(manifest: PhiSessionManifest): ReturnType<typeof fixture> & {
  context: { originSessionId: string; kernelExecutionHost: 'local'; signal: AbortSignal }
} {
  const f = fixture()
  f.setProject(manifest.projectId ? localProject : undefined)
  f.setOrigin({ phiSessionId: manifest.sessionId, cwd: manifest.cwd })
  f.setManifest(manifest)
  return {
    ...f,
    context: {
      originSessionId: 'runtime-session',
      kernelExecutionHost: 'local' as const,
      signal: f.controller.signal
    }
  }
}

for (const manifest of [localManifest, ordinaryManifest]) {
  test(`Local kernel Wrapper starts for ${manifest.kind} sessions with its trusted origin and signal`, async () => {
    const f = localFixture(manifest)
    const requests: Parameters<WrapperJobClient['start']>[] = []
    const client: WrapperJobClient = {
      start: async (...args) => {
        requests.push(args)
        return { ok: false, error: 'fixture stops before launch' }
      },
      status: async () => undefined,
      list: async () => [],
      cancel: async () => ({ ok: false, error: 'unused' }),
      wait: async () => undefined
    }
    const handlers = wrapperJobHostHandlers(client, {
      scopeFor: (ctx) => resolveWrapperJobHostScope(ctx, f.dependencies)
    })
    const input = { id: 'wrapper', target: 'local', originSessionId: 'other-runtime' }
    await handlers['wrapperJob.start'](input, f.context)
    assert.equal(requests.length, 1)
    assert.equal(requests[0][0].target, 'local')
    assert.equal(requests[0][0].originSessionId, 'runtime-session')
    assert.equal(requests[0][1]?.signal, f.controller.signal)
    assert(!f.calls.some((call) => call.startsWith('target:') || call.startsWith('binding:')))
    f.controller.abort(new Error('chat stopped'))
    await assert.rejects(async () => handlers['wrapperJob.start'](input, f.context), /chat stopped/)
    assert.equal(requests.length, 1)
  })
}

test('Local kernel scope can control only its composition jobs with resolvable session ownership', () => {
  const f = localFixture(localManifest)
  const { resolveOrigin } = f.dependencies
  f.dependencies.resolveOrigin = (id) =>
    id === 'runtime-session'
      ? resolveOrigin(id)
      : id === 'peer'
        ? { phiSessionId: 'other-session', cwd: localManifest.cwd }
        : undefined
  const owner = { origin: 'composition', originSessionId: 'runtime-session' } as WrapperRun
  const records = new Map<string, WrapperRun>([
    ['owned', owner],
    ['peer', { ...owner, originSessionId: 'peer' }],
    ['expired', { ...owner, originSessionId: 'expired' }],
    ['plan', { ...owner, origin: undefined }]
  ])
  f.dependencies.readRun = (id) => records.get(id)
  const scope = resolveWrapperJobHostScope(f.context, f.dependencies)
  assert.equal(scope?.executionHost, 'local')
  for (const id of ['owned', 'peer', 'expired', 'plan', 'missing']) {
    assert.equal(scope.ownsRun(id), id === 'owned', id)
  }
})

test('Local kernel scope rejects stale SSH bindings and a moved project or ordinary workspace', () => {
  const alias = localFixture({
    ...ordinaryManifest,
    cwd: '/alias-to-ssh-anchor',
    cwdRealPath: remoteProjectAnchorPath('remote-project')
  })
  assert.throws(
    () => resolveWrapperJobHostScope(alias.context, alias.dependencies),
    /binding changed/i
  )
  const f = localFixture(localManifest)
  f.setManifest(remoteManifest)
  assert.throws(() => resolveWrapperJobHostScope(f.context, f.dependencies))
  f.setManifest(localManifest)
  f.setProject(remoteProject)
  assert.throws(() => resolveWrapperJobHostScope(f.context, f.dependencies))

  for (const manifest of [localManifest, ordinaryManifest]) {
    const local = localFixture(manifest)
    const scope = resolveWrapperJobHostScope(local.context, local.dependencies)
    assert.ok(scope?.assertCurrent)
    local.setManifest({ ...manifest, remoteRuntime: 'rpc' })
    assert.throws(scope.assertCurrent, /binding changed/i, 'stale SSH runtime on local manifest')
    local.setManifest({
      ...manifest,
      cwd: '/moved',
      cwdRealPath: '/moved',
      ...(manifest.projectId
        ? { projectLocation: { kind: 'local', path: '/moved', realPath: '/moved' } }
        : {})
    })
    assert.throws(scope.assertCurrent, /binding changed/i, 'local directory changed during request')
    local.setManifest(manifest)
    local.setOrigin({ phiSessionId: 'other-session', cwd: manifest.cwd })
    assert.throws(scope.assertCurrent, /binding changed/i, 'origin changed during request')
  }
})
