import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { KernelSessionFactory } from '../src/main/agent/engine/kernel-session-factory'
import {
  createPhiSession,
  deletePhiSession,
  findPhiSessionById
} from '../src/main/agent/session/session-store'
import { writeManifestFile } from '../src/main/agent/session/manifest-file'
import {
  remoteOmpDurableSessionKey,
  type RemoteOmpRuntimeRef
} from '../src/main/agent/session/runtime-reference'
import { FakeKernelClient, params } from './helpers/kernelSessionFactoryFake'

test('persistent Phi history records and reopens the same local kernel session identity', async (t) => {
  const phi = createPhiSession({
    kind: 'ordinary',
    cwd: '/project',
    cwdRealPath: '/project',
    permissionMode: 'auto',
    model: { providerId: 'test', modelId: 'model' }
  })
  t.after(() => deletePhiSession(phi.sessionId))
  const client = new FakeKernelClient()
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: 'test' },
        kernelInstanceId: 'kernel-instance',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/home/test', agentDir: '/agent' }
      },
      close: async () => undefined
    })
  })
  const firstParams = { ...params('first'), phiSessionId: phi.sessionId }
  const first = await factory.create(firstParams, new AbortController().signal, {
    event: () => undefined,
    state: () => undefined
  })
  assert.deepEqual(findPhiSessionById(phi.sessionId)?.kernelRuntimeRef, {
    kind: 'phi-kernel',
    version: 1,
    kernelSessionId: 'kernel-1',
    host: { kind: 'local', agentDir: '/agent' }
  })
  await first.dispose()

  await factory.create(
    {
      ...params('second'),
      phiSessionId: phi.sessionId,
      sessionManager: {
        kind: 'open',
        cwd: '/project',
        path: `phi-session:${phi.sessionId}`
      }
    },
    new AbortController().signal,
    { event: () => undefined, state: () => undefined }
  )
  assert.equal(client.requests.filter((request) => request.method === 'session.create').length, 1)
  assert.equal(client.requests.filter((request) => request.method === 'session.open').length, 1)
})

test('RPC-era remote history adopts through the routed desktop factory and publishes kernel identity', async (t) => {
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'ssh-config:contract',
    remoteRoot: '/srv/project',
    canonicalRoot: '/srv/project'
  }
  const phi = createPhiSession({
    kind: 'project',
    projectId: 'project-remote',
    projectLocation: location,
    cwd: '/local/anchor',
    cwdRealPath: '/local/anchor',
    remoteRuntime: 'rpc',
    permissionMode: 'ask',
    model: { providerId: 'test', modelId: 'model' }
  })
  t.after(() => deletePhiSession(phi.sessionId))
  const scope = {
    hostProfileId: location.hostProfileId,
    bindingHash: 'a'.repeat(64),
    projectId: 'project-remote',
    projectRoot: location.canonicalRoot,
    runtimeRoot: '/srv/runtime'
  }
  const runtimeRef: RemoteOmpRuntimeRef = {
    kind: 'remote-omp',
    version: 1,
    ...scope,
    durableSessionKey: remoteOmpDurableSessionKey(scope, phi.sessionId),
    ompSessionId: 'omp-session',
    journalBasename: 'session.jsonl',
    ompVersion: '18.10.3'
  }
  writeManifestFile(phi.dir, { ...phi.manifest, runtimeRef })

  const client = new FakeKernelClient()
  const factory = new KernelSessionFactory({
    mode: 'remote',
    launchRemote: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: '18.10.3' },
        kernelInstanceId: 'remote-kernel',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/srv/runtime/kernel-home', agentDir: '/srv/runtime/kernel-home/agent' }
      },
      runtimeRoot: '/srv/runtime',
      planHistory: async () => ({
        action: 'adopt-remote',
        reason: 'verified',
        status: 'ready',
        phiSessionId: phi.sessionId,
        source: {
          kind: 'omp-journal',
          path: '/srv/runtime/omp-sessions/source/session.jsonl',
          cwd: '/srv/project',
          origin: 'rpc-remote',
          phiSessionId: phi.sessionId,
          expected: { sha256: 'c'.repeat(64), size: 123 }
        },
        runtimeRef
      }),
      close: async () => undefined
    })
  })
  await factory.create(
    {
      ...params('remote-open'),
      phiSessionId: phi.sessionId,
      cwd: '/local/anchor',
      sessionManager: {
        kind: 'open',
        cwd: '/local/anchor',
        path: `phi-session:${phi.sessionId}`
      },
      remoteProject: {
        phiSessionId: phi.sessionId,
        projectId: 'project-remote',
        location,
        contextFiles: []
      }
    },
    new AbortController().signal,
    { event: () => undefined, state: () => undefined }
  )
  assert.equal(client.requests.filter((request) => request.method === 'session.adopt').length, 1)
  assert.equal(client.requests.filter((request) => request.method === 'session.open').length, 1)
  const manifest = findPhiSessionById(phi.sessionId)
  assert.equal(manifest?.runtimeRef, undefined)
  assert.deepEqual(manifest?.kernelRuntimeRef, {
    kind: 'phi-kernel',
    version: 1,
    kernelSessionId: 'kernel-adopted',
    host: {
      kind: 'ssh',
      hostProfileId: 'ssh-config:contract',
      projectId: 'project-remote',
      projectRoot: '/srv/project',
      runtimeRoot: '/srv/runtime',
      home: '/srv/runtime/kernel-home',
      agentDir: '/srv/runtime/kernel-home/agent'
    }
  })
  const rawManifest = JSON.parse(readFileSync(join(phi.dir, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >
  assert.equal((rawManifest.runtimeRef as { kind?: unknown }).kind, 'phi-kernel')
  assert.equal(Object.hasOwn(rawManifest, 'kernelRuntimeRef'), false)
})
