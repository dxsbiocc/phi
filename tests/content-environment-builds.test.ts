import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEnvironmentBuilds } from '../src/main/agent/content/environment-builds'
import type { EnvironmentDescriptor } from '../src/main/agent/content/environment-refs'
import { computeEnvId, type EnvHandle, type EnvMetadata } from '../src/main/agent/envs'
import { packageArchiveName } from '../src/main/agent/envs/estimate'
import type { EnvironmentBuild } from '../src/shared/environmentBuildTypes'

const MD5 = '0123456789abcdef0123456789abcdef'
const PACKAGE_URL = `https://conda.anaconda.org/conda-forge/osx-arm64/zlib-1.3-h0.conda#${MD5}`
const LOCK = ['# baseline: osx 11.0', '# download-bytes: 100', '@EXPLICIT', PACKAGE_URL, ''].join(
  '\n'
)

function descriptor(name = 'minimal'): EnvironmentDescriptor {
  return {
    ref: 'phi:python@1',
    scope: 'phi',
    kind: 'base',
    spec: { name, channels: ['conda-forge'], dependencies: ['python=3.12'] },
    lockText: LOCK,
    platform: 'darwin-arm64'
  }
}

function envIdFor(name = 'minimal'): string {
  const spec = descriptor(name)
  return computeEnvId({
    scope: spec.scope,
    name: spec.spec.name,
    platform: spec.platform,
    lockText: spec.lockText
  })
}

function fakeHandle(envId: string): EnvHandle {
  const metadata: EnvMetadata = {
    envId,
    name: 'minimal',
    kind: 'base',
    platform: 'darwin-arm64',
    lockSha256: 'a'.repeat(64),
    createdAt: '2026-09-30T00:00:00.000Z',
    micromambaVersion: '2.9.0',
    activation: { set: {}, pathPrepend: [] },
    host: {},
    sourcePackages: [],
    status: 'ready',
    contractVersion: '1.1.0'
  }
  return { envId, prefix: `/tmp/${envId}`, metadata }
}

test('progress events update phase and a second start joins the running build', async () => {
  const events: EnvironmentBuild[] = []
  let calls = 0
  let release: (handle: EnvHandle) => void = () => undefined
  const builds = createEnvironmentBuilds({
    root: '/tmp/phi-builds',
    onChange: (build) => events.push(build),
    build: async (_root, _descriptor, options) => {
      calls += 1
      options?.onProgress?.({ phase: 'check', message: 'checking the lock' })
      options?.onProgress?.({ phase: 'create', message: 'downloading packages' })
      return new Promise<EnvHandle>((resolve) => {
        release = resolve
      })
    }
  })
  const spec = descriptor()
  const envId = envIdFor()
  const first = builds.start(spec, { ref: spec.ref, requestedBy: { skill: 'echo' } })
  const second = builds.start(spec, { ref: spec.ref })
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(builds.list()[0]?.state, 'building')
  assert.equal(builds.list()[0]?.phase, 'create')
  assert.equal(builds.list()[0]?.message, 'downloading packages')
  assert.deepEqual(
    events.map((event) => event.phase),
    ['check', 'check', 'create']
  )

  const handle = fakeHandle(envId)
  release(handle)
  assert.equal(await first, handle)
  assert.equal(await second, handle)
  assert.equal(builds.list()[0]?.state, 'ready')
  assert.equal(builds.list()[0]?.envId, envId)
  assert.equal(events.at(-1)?.state, 'ready')
})

test('cancel aborts the build and failure is recorded', async () => {
  let signal: AbortSignal | undefined
  const builds = createEnvironmentBuilds({
    root: '/tmp/phi-builds',
    build: (_root, _descriptor, options) => {
      signal = options?.signal
      options?.onProgress?.({ phase: 'create', message: 'downloading packages' })
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('environment build aborted'))
        })
      })
    }
  })
  const envId = envIdFor()
  const pending = builds.start(descriptor(), { ref: 'phi:python@1' })
  await Promise.resolve()
  builds.cancel(envId)
  await assert.rejects(pending, /environment build aborted/)
  assert.equal(signal?.aborted, true)
  assert.equal(builds.list()[0]?.state, 'cancelled')
  assert.equal(builds.list()[0]?.error, 'environment build cancelled')
  builds.cancel(envId)
  assert.equal(builds.list()[0]?.state, 'cancelled')

  const failed = createEnvironmentBuilds({
    root: '/tmp/phi-builds',
    build: async (_root, _descriptor, options) => {
      options?.onProgress?.({ phase: 'failed', message: 'solver exploded' })
      throw new Error('solver exploded')
    }
  })
  await assert.rejects(failed.start(descriptor(), { ref: 'phi:python@1' }), /solver exploded/)
  assert.equal(failed.list()[0]?.state, 'failed')
  assert.equal(failed.list()[0]?.error, 'solver exploded')
  assert.equal(failed.list()[0]?.phase, 'failed')
})

test('create progress is sampled from the package cache at most once a second', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const root = mkdtempSync(join(tmpdir(), 'phi-build-progress-'))
  try {
    const events: EnvironmentBuild[] = []
    let rejectBuild: (error: Error) => void = () => undefined
    const builds = createEnvironmentBuilds({
      root,
      onChange: (build) => events.push(build),
      build: (_root, _descriptor, options) => {
        options?.onProgress?.({ phase: 'create', message: 'downloading packages' })
        return new Promise((_resolve, reject) => {
          rejectBuild = reject
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('environment build aborted'))
          })
        })
      }
    })
    const pending = builds.start(descriptor(), { ref: 'phi:python@1' })
    await Promise.resolve()
    const before = events.filter((event) => event.progress.packagesDone === 1)
    assert.equal(before.length, 0)
    t.mock.timers.tick(999)
    assert.equal(events.filter((event) => event.progress.packagesDone === 1).length, 0)

    mkdirSync(join(root, 'pkgs'), { recursive: true })
    writeFileSync(join(root, 'pkgs', packageArchiveName(PACKAGE_URL)), Buffer.alloc(40))
    t.mock.timers.tick(1)
    const sampled = events.filter((event) => event.progress.packagesDone === 1)
    assert.equal(sampled.length, 1)
    assert.equal(sampled[0]?.progress.bytesDone, 40)
    assert.equal(sampled[0]?.progress.bytesTotal, 100)
    assert.equal(sampled[0]?.state, 'building')

    t.mock.timers.tick(1000)
    assert.equal(events.filter((event) => event.progress.packagesDone === 1).length, 1)

    builds.cancel(envIdFor())
    await assert.rejects(pending, /aborted/)
    void rejectBuild
  } finally {
    t.mock.timers.reset()
    rmSync(root, { recursive: true, force: true })
  }
})

test('finished builds are kept newest first, at most 20', async () => {
  const builds = createEnvironmentBuilds({
    root: '/tmp/phi-builds',
    build: async (_root, spec) => fakeHandle(`done-${spec.spec.name}`)
  })
  const ids: string[] = []
  for (let index = 0; index < 21; index += 1) {
    const name = `pkg${String(index)}`
    ids.push(envIdFor(name))
    await builds.start(descriptor(name), { ref: 'phi:python@1' })
  }
  const listed = builds.list()
  assert.equal(listed.length, 20)
  assert.equal(listed[0]?.envId, ids[20])
  assert.equal(
    listed.some((entry) => entry.envId === ids[0]),
    false
  )
  assert.equal(
    listed.every((entry) => entry.state === 'ready'),
    true
  )
})
