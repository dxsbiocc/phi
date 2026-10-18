import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'
import { countWorkspaceHostOperations } from './helpers/countingWorkspaceHost'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  readFakeMicromambaInvocations
} from './helpers/remoteRuntimeFixture'

const ENVIRONMENT_HOST_OPERATION_BASELINE = { create: 9, reuse: 9 } as const
const ENVIRONMENT_HOST_OPERATION_LIMIT = 8

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'environment-request-1',
    runtimeSessionId: 'runtime-1',
    cwd: '/local/anchor-that-must-not-be-used',
    packages: ['six'],
    reason: '远程脚本需要 six',
    environment: 'phi:python@1',
    ...overrides
  }
}

test('remote env_request paths report WorkspaceHost operation baselines', async (t) => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const options = {
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true,
      resolveBasePackages: async () => ['python=3.12']
    }
    const counter = countWorkspaceHostOperations(fixture.workspace)
    const first = await new RemoteEnvironmentService(options).request(request())
    assert.ok('envId' in first)
    const create = counter.snapshot()
    counter.reset()

    const second = await new RemoteEnvironmentService(options).request(
      request({ requestId: 'environment-count-reuse' })
    )
    assert.deepEqual(second, first)
    const reuse = counter.snapshot()

    t.diagnostic(`environment create host operations: ${JSON.stringify(create)}`)
    t.diagnostic(`environment reuse host operations: ${JSON.stringify(reuse)}`)
    assertEnvironmentHostOperationLimit(
      'environment create',
      create.total,
      ENVIRONMENT_HOST_OPERATION_BASELINE.create
    )
    assertEnvironmentHostOperationLimit(
      'environment reuse',
      reuse.total,
      ENVIRONMENT_HOST_OPERATION_BASELINE.reuse
    )
  } finally {
    fixture.cleanup()
  }
})

function assertEnvironmentHostOperationLimit(
  label: string,
  actual: number,
  baseline: number
): void {
  assert.ok(
    actual <= ENVIRONMENT_HOST_OPERATION_LIMIT,
    `${label}: ${actual} host operations exceeds ${ENVIRONMENT_HOST_OPERATION_LIMIT} (baseline ${baseline})`
  )
}

test('remote env_request creates and then reuses a content-addressed environment', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    let confirmations = 0
    const options = {
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => {
        confirmations += 1
        return true
      },
      resolveBaseEnvironment: async () => ({
        packages: ['python=3.12'],
        channels: ['conda-forge', 'bioconda']
      })
    }
    const service = new RemoteEnvironmentService(options)
    const first = await service.request(
      request({ channels: ['https://untrusted.invalid/channel'] })
    )
    const second = await new RemoteEnvironmentService(options).request(
      request({ requestId: 'environment-request-2' })
    )
    assert.ok('ref' in first)
    const chained = await service.request(
      request({ requestId: 'environment-request-3', environment: first.ref })
    )

    assert.ok('envId' in first)
    assert.ok('envId' in chained)
    assert.deepEqual(second, first)
    assert.equal(chained.envId, first.envId)
    assert.equal(confirmations, 3)
    const prefix = join(fixture.runtimeRoot, 'envs', first.envId)
    assert.equal(existsSync(join(prefix, 'conda-meta', 'history')), true)
    const calls = readFileSync(join(fixture.runtimeRoot, 'micromamba-calls.log'), 'utf8')
      .trim()
      .split('\n')
    assert.equal(calls.length, 1)
    assert.match(
      calls[0] ?? '',
      /^create --no-rc -p .*\/envs\/[a-f0-9]{64} --override-channels -c conda-forge -c bioconda --yes/u
    )
    assert.doesNotMatch(calls[0] ?? '', /untrusted\.invalid/u)
    assert.match(calls[0] ?? '', new RegExp(`root=${escapeRegExp(fixture.runtimeRoot)}$`))
    const [invocation] = readFakeMicromambaInvocations(fixture)
    assert.equal(invocation?.env.MAMBA_ROOT_PREFIX, fixture.runtimeRoot)
    assert.equal(invocation?.env.MAMBA_PKGS_DIRS, join(fixture.runtimeRoot, 'pkgs'))
    assert.equal(invocation?.env.XDG_CACHE_HOME, join(fixture.runtimeRoot, 'cache'))
    assert.notEqual(invocation?.env.XDG_CACHE_HOME, join(fixture.remoteHome, '.cache'))
    assert.ok(invocation?.env.HOME)
    assert.equal(invocation?.env.PATH, '/usr/bin:/bin')
    assert.equal(
      Object.keys(invocation?.env ?? {}).some((key) => key.startsWith('CONDA_')),
      false
    )
    assert.deepEqual(invocation?.argv.slice(0, 2), ['create', '--no-rc'])
    assert.equal(existsSync(join(fixture.localAnchor, '.phi')), false)
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request honors a server-level micromamba path override', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const managed = installFakeMicromamba(fixture)
    const custom = join(fixture.root, 'custom-bin', 'micromamba')
    mkdirSync(join(fixture.root, 'custom-bin'))
    copyFileSync(managed, custom)
    chmodSync(custom, 0o755)
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => ({ ...fixture.workspace, micromambaPath: custom }),
      confirm: async () => true,
      resolveBasePackages: async () => ['python=3.12']
    })

    const result = await service.request(request({ requestId: 'custom-micromamba' }))

    assert.ok('envId' in result)
    assert.equal(service.micromambaPath({ ...fixture.workspace, micromambaPath: custom }), custom)
  } finally {
    fixture.cleanup()
  }
})

test('fake micromamba rejects a resolved executable basename from the legacy layout', () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const binary = installFakeMicromamba(fixture)
    const legacyPath = join(fixture.runtimeRoot, 'bin', 'micromamba-legacy-test')
    copyFileSync(binary, legacyPath)
    chmodSync(legacyPath, 0o755)

    const result = spawnSync(legacyPath, ['run'], {
      encoding: 'utf8',
      env: { ...process.env, MAMBA_ROOT_PREFIX: fixture.runtimeRoot }
    })

    assert.equal(result.status, 1)
    assert.equal(
      result.stderr,
      `Error unknown MAMBA_EXE: "${legacyPath}", filename must be mamba or micromamba\n`
    )
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request serializes one shared environment across projects', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const firstRoot = join(fixture.projectRoot, 'first')
    const secondRoot = join(fixture.projectRoot, 'second')
    for (const root of [firstRoot, secondRoot]) await fixture.workspace.projectHost.fs.mkdirp(root)
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async (runtimeSessionId) => ({
        ...fixture.workspace,
        projectRoot: runtimeSessionId === 'runtime-1' ? firstRoot : secondRoot
      }),
      confirm: async () => true,
      resolveBasePackages: async () => ['python=3.12']
    })

    const [first, second] = await Promise.all([
      service.request(request()),
      service.request(
        request({ requestId: 'environment-request-2', runtimeSessionId: 'runtime-2' })
      )
    ])

    assert.ok('envId' in first)
    assert.ok('envId' in second)
    assert.equal(first.envId, second.envId)
    const calls = readFileSync(join(fixture.runtimeRoot, 'micromamba-calls.log'), 'utf8')
      .trim()
      .split('\n')
    assert.equal(calls.length, 1)
  } finally {
    fixture.cleanup()
  }
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('remote env_request rejects package arguments that could become micromamba options', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true
    })

    const result = await service.request(request({ packages: ['--help'] }))

    assert.ok('error' in result)
    assert.match(result.error, /invalid conda match spec/u)
    assert.equal(existsSync(join(fixture.runtimeRoot, 'micromamba-calls.log')), false)
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request reports a missing micromamba without installing or falling back locally', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    writeFileSync(join(fixture.localAnchor, 'sentinel.txt'), 'untouched')
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true
    })

    const result = await service.request(request())

    assert.ok('error' in result)
    assert.match(result.error, /Settings.+Install micromamba/u)
    assert.match(result.error, /did not fall back.+locally/u)
    assert.equal(readFileSync(join(fixture.localAnchor, 'sentinel.txt'), 'utf8'), 'untouched')
    assert.equal(
      existsSync(join(fixture.runtimeRoot, 'bin', 'micromamba-test', 'micromamba')),
      false
    )
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request decline performs no server execution', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => false
    })

    assert.deepEqual(await service.request(request()), { declined: true })
    assert.equal(existsSync(join(fixture.runtimeRoot, 'micromamba-calls.log')), false)
  } finally {
    fixture.cleanup()
  }
})

test('remote environment binding returns only the server prefix', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true
    })
    const created = await service.request(request())
    assert.ok('ref' in created)

    const bound = await service.bindSession({
      runtimeSessionId: 'runtime-1',
      ref: created.ref,
      agent: 'RemoteAgent',
      cwd: fixture.localAnchor
    })

    assert.equal(bound.ref, created.ref)
    assert.equal(
      (bound.variables as Record<string, string>).CONDA_PREFIX,
      join(fixture.runtimeRoot, 'envs', created.envId)
    )
    assert.doesNotMatch(JSON.stringify(bound), new RegExp(escapeRegExp(fixture.localAnchor)))
    await fixture.workspace.runtimeHost.fs.remove(
      join('envs', created.envId, '.phi-remote-env.json')
    )
    const incomplete = await service.bindSession({
      runtimeSessionId: 'runtime-1',
      ref: created.ref,
      agent: 'RemoteAgent',
      cwd: fixture.localAnchor
    })
    assert.ok('notReady' in incomplete)
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request enforces its server timeout', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const binary = installFakeMicromamba(fixture)
    writeFileSync(binary, '#!/bin/sh\nsleep 30\n')
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true,
      timeoutMs: 100
    })

    const result = await service.request(request())

    assert.ok('error' in result)
    assert.match(result.error, /timed out/u)
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request preserves the slow-server runtime-root retry guidance', async () => {
  const service = new RemoteEnvironmentService({
    micromambaVersion: 'test',
    openWorkspace: async () => {
      throw new Error('服务器响应慢，运行时根目录检查超时，请稍后重试。')
    },
    confirm: async () => true
  })

  const result = await service.request(request())

  assert.ok('error' in result)
  assert.match(result.error, /服务器响应慢.*稍后重试/u)
})

test('remote env_request turns conda connectivity failures into an actionable English error', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture, 'test', 'offline')
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true
    })

    const result = await service.request(request())

    assert.ok('error' in result)
    assert.match(result.error, /cannot reach the conda/u)
    assert.match(result.error, /local cache cannot satisfy/u)
    assert.match(result.error, /mirror/u)
    assert.match(result.error, /machine with network access/u)
    const calls = readFakeMicromambaInvocations(fixture)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.argv.includes('--offline'), false)
    assert.equal(calls[1]?.argv.includes('--offline'), true)
    assert.equal(existsSync(join(fixture.localAnchor, '.phi')), false)
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request retries once offline and reports a sufficient Phi cache', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture, 'test', 'cached-offline')
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true
    })

    const result = await service.request(request({ requestId: 'cached-offline' }))

    assert.ok('envId' in result)
    assert.equal(result.notice, 'Used the local cache')
    const calls = readFakeMicromambaInvocations(fixture)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.argv.includes('--offline'), false)
    assert.equal(calls[1]?.argv.filter((arg) => arg === '--offline').length, 1)
    assert.ok((calls[1]?.argv.indexOf('--offline') ?? -1) < (calls[1]?.argv.indexOf('six') ?? -1))
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request diagnoses a silent quota failure during its offline retry', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const binary = installFakeMicromamba(fixture)
    writeFileSync(
      binary,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "\${MAMBA_ROOT_PREFIX:?}/offline-retry-calls.log"
case " $* " in
  *" --offline "*) exit 1 ;;
esac
printf 'Could not resolve host: conda.anaconda.org\\n' >&2
exit 7
`
    )
    chmodSync(binary, 0o755)
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true,
      writeProbeFailure: 'quota-exceeded'
    })

    const result = await service.request(request({ requestId: 'offline-silent-quota' }))

    assert.ok('error' in result)
    assert.match(result.error, /Disk space or the file count quota is exhausted/u)
    assert.doesNotMatch(result.error, /local cache cannot satisfy/u)
    const calls = readFileSync(join(fixture.runtimeRoot, 'offline-retry-calls.log'), 'utf8')
      .trim()
      .split('\n')
    assert.equal(calls.length, 2)
    assert.match(calls[1] ?? '', /--offline.*six/u)
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request diagnoses a silent quota failure and cleans its write probe', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture, 'test', 'silent')
    const run = fixture.workspace.projectHost.exec.run
    const probeLimits: Array<{ timeoutMs?: number; maxOutputBytes?: number }> = []
    fixture.workspace.projectHost.exec.run = (command, options) => {
      if (command[0] === 'sh' && command[2]?.includes('.phi-write-probe')) {
        probeLimits.push({
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes
        })
      }
      return run(command, options)
    }
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true,
      writeProbeFailure: 'quota-exceeded'
    })

    const result = await service.request(request({ requestId: 'silent-quota' }))

    assert.ok('error' in result)
    assert.match(result.error, /Disk space or the file count quota is exhausted/u)
    assert.match(result.error, /Settings → Remote Hosts/u)
    assert.deepEqual(probeLimits, [{ timeoutMs: 10_000, maxOutputBytes: 32 * 1024 }])
    assert.equal(
      readdirSync(fixture.runtimeRoot).some((name) => name.startsWith('.phi-write-probe-')),
      false
    )
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request cancellation terminates the server command', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const binary = installFakeMicromamba(fixture)
    writeFileSync(binary, '#!/bin/sh\nsleep 30\n')
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true,
      timeoutMs: 60_000
    })
    const pending = service.request(request())
    setTimeout(() => service.cancel({ requestId: 'environment-request-1' }), 80)

    const result = await pending

    assert.ok('error' in result)
    assert.match(result.error, /cancelled/u)
  } finally {
    fixture.cleanup()
  }
})
