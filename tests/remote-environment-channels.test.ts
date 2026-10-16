import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  readFakeMicromambaInvocations
} from './helpers/remoteRuntimeFixture'

test('an empty trusted base channel list retains the legacy default and ignores wire channels', async () => {
  const f = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(f)
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => f.workspace,
      confirm: async () => true,
      resolveBaseEnvironment: async () => ({ packages: ['python=3.12'], channels: [] })
    })
    const created = await service.request({
      runtimeSessionId: 'runtime',
      requestId: 'empty-base',
      environment: 'phi:python@1',
      packages: ['six'],
      reason: 'default channel compatibility',
      channels: ['https://untrusted.invalid']
    })
    assert.ok('envId' in created)
    const call = readFakeMicromambaInvocations(f).at(-1)!
    const at = call.argv.indexOf('--override-channels')
    assert.deepEqual(call.argv.slice(at, at + 4), [
      '--override-channels',
      '-c',
      'conda-forge',
      '--yes'
    ])
    assert.equal(
      call.argv.some((arg) => arg.includes('untrusted.invalid')),
      false
    )
    const marker = JSON.parse(
      readFileSync(join(f.runtimeRoot, 'envs', created.envId, '.phi-remote-env.json'), 'utf8')
    )
    assert.deepEqual(marker.channels, ['conda-forge'])
  } finally {
    f.cleanup()
  }
})

test('stored environment channels retain their priority and identity during reuse and extension', async () => {
  const f = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(f)
    const options = {
      micromambaVersion: 'test',
      openWorkspace: async () => f.workspace,
      confirm: async () => true,
      resolveBasePackages: async () => ['python=3.12']
    }
    const request = {
      runtimeSessionId: 'runtime',
      requestId: 'seed',
      environment: 'phi:python@1',
      packages: ['six'],
      reason: 'channel regression'
    }
    const seed = await new RemoteEnvironmentService(options).request(request)
    assert.ok('envId' in seed)
    const previousRoot = join(f.runtimeRoot, 'envs', seed.envId)
    const previous = JSON.parse(readFileSync(join(previousRoot, '.phi-remote-env.json'), 'utf8'))
    // A valid pre-existing multi-channel record, independent of the create path under test.
    const channels = ['bioconda', 'conda-forge']
    const envId = createHash('sha256')
      .update(JSON.stringify({ packages: [...previous.packages].sort(), channels }))
      .digest('hex')
    const name = `remote-${envId.slice(0, 16)}`
    const prefix = join(f.runtimeRoot, 'envs', envId)
    const stored = { ...previous, envId, name, prefix, ref: `project:${name}`, channels }
    renameSync(previousRoot, prefix)
    writeFileSync(join(prefix, '.phi-remote-env.json'), JSON.stringify(stored) + '\n')
    const aliasRoot = join(f.runtimeRoot, 'envs', 'aliases')
    for (const project of readdirSync(aliasRoot)) {
      for (const file of readdirSync(join(aliasRoot, project))) {
        const path = join(aliasRoot, project, file)
        const alias = JSON.parse(readFileSync(path, 'utf8'))
        if (alias.ref === request.environment)
          writeFileSync(path, JSON.stringify({ ...stored, ref: request.environment }) + '\n')
      }
    }
    const service = new RemoteEnvironmentService({
      ...options,
      resolveBaseEnvironment: async () => {
        throw new Error('Existing aliases must not be replaced by a current base descriptor')
      }
    })
    const before = readFakeMicromambaInvocations(f)
    const reused = await service.request({
      ...request,
      requestId: 'reuse',
      channels: ['https://untrusted.invalid']
    })
    assert.ok('envId' in reused)
    assert.equal(reused.envId, envId)
    assert.deepEqual(readFakeMicromambaInvocations(f), before)
    const extended = await service.request({
      ...request,
      requestId: 'extend',
      packages: ['pandas']
    })
    assert.ok('envId' in extended)
    assert.equal(
      extended.envId,
      createHash('sha256')
        .update(JSON.stringify({ packages: [...previous.packages, 'pandas'].sort(), channels }))
        .digest('hex')
    )
    const invocation = readFakeMicromambaInvocations(f).at(-1)!
    const at = invocation.argv.indexOf('--override-channels')
    assert.deepEqual(invocation.argv.slice(at, at + 5), [
      '--override-channels',
      '-c',
      'bioconda',
      '-c',
      'conda-forge'
    ])
    assert.equal(
      invocation.argv.some((arg) => arg.includes('untrusted.invalid')),
      false
    )
    const marker = JSON.parse(
      readFileSync(join(f.runtimeRoot, 'envs', extended.envId, '.phi-remote-env.json'), 'utf8')
    )
    assert.deepEqual(marker.channels, channels)
  } finally {
    f.cleanup()
  }
})
