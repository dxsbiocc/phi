import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  readFakeMicromambaInvocations
} from './helpers/remoteRuntimeFixture'

const ref = 'phi:python@1'
async function setup(): Promise<{
  f: ReturnType<typeof createRemoteRuntimeFixture>
  service: RemoteEnvironmentService
  seeded: { envId: string }
  confirmations(): number
}> {
  const f = createRemoteRuntimeFixture()
  installFakeMicromamba(f)
  let confirmations = 0
  const service = new RemoteEnvironmentService({
    openWorkspace: async () => f.workspace,
    micromambaVersion: 'test',
    confirm: async () => {
      confirmations++
      return true
    },
    resolveBasePackages: async () => ['bash']
  })
  const seeded = await service.request({
    runtimeSessionId: 'runtime',
    requestId: 'seed',
    environment: ref,
    packages: ['coreutils'],
    reason: 'ready descriptor fixture'
  })
  assert.ok('envId' in seeded, JSON.stringify(seeded))
  return { f, service, seeded, confirmations: () => confirmations }
}

test('ready descriptor pins the existing environment and marker bytes without a build or confirmation', async () => {
  const { f, service, seeded, confirmations } = await setup()
  try {
    const before = readFakeMicromambaInvocations(f)
    const ready = await service.describeReadyInWorkspace(ref, f.workspace)
    assert.ok(ready?.execution)
    assert.equal(ready.environmentId, seeded.envId)
    assert.equal(ready.lockSha256, seeded.envId)
    assert.equal(ready.status, 'ready')
    assert.equal(ready.execution.prefixPath, join(f.runtimeRoot, 'envs', seeded.envId))
    assert.equal(ready.execution.runtimeRoot, f.runtimeRoot)
    assert.equal(ready.execution.micromambaPath, service.micromambaPath(f.workspace))
    assert.equal(
      ready.execution.markerSha256,
      createHash('sha256').update(readFileSync(ready.execution.markerPath)).digest('hex')
    )
    assert.equal(confirmations(), 1)
    assert.deepEqual(readFakeMicromambaInvocations(f), before)
    assert.equal(await service.describeReadyInWorkspace('phi:missing@1', f.workspace), undefined)
    assert.deepEqual(readFakeMicromambaInvocations(f), before)
  } finally {
    f.cleanup()
  }
})

test('ready descriptor refuses matching but forged package metadata under the old environment ID', async () => {
  const { f, service, seeded } = await setup()
  try {
    const markerPath = join(f.runtimeRoot, 'envs', seeded.envId, '.phi-remote-env.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    marker.packages.push('unexpected-package')
    writeFileSync(markerPath, JSON.stringify(marker))
    const root = join(f.runtimeRoot, 'envs', 'aliases')
    for (const project of readdirSync(root))
      for (const name of readdirSync(join(root, project))) {
        const file = join(root, project, name)
        const alias = JSON.parse(readFileSync(file, 'utf8'))
        alias.packages = marker.packages
        writeFileSync(file, JSON.stringify(alias))
      }
    const before = readFakeMicromambaInvocations(f)
    assert.equal(await service.describeReadyInWorkspace(ref, f.workspace), undefined)
    assert.deepEqual(readFakeMicromambaInvocations(f), before)
  } finally {
    f.cleanup()
  }
})

test('missing conda history and aborted descriptor lookup never repair or create an environment', async () => {
  const { f, service, seeded } = await setup()
  try {
    rmSync(join(f.runtimeRoot, 'envs', seeded.envId, 'conda-meta', 'history'))
    const before = readFakeMicromambaInvocations(f)
    assert.equal(await service.describeReadyInWorkspace(ref, f.workspace), undefined)
    const stopped = new AbortController()
    stopped.abort(new Error('selected project changed'))
    await assert.rejects(
      service.describeReadyInWorkspace(ref, f.workspace, stopped.signal),
      /selected project changed/
    )
    assert.deepEqual(readFakeMicromambaInvocations(f), before)
  } finally {
    f.cleanup()
  }
})
