import assert from 'node:assert/strict'
import test from 'node:test'

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
