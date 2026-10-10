import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'
import { createRemoteRuntimeFixture, installFakeMicromamba } from './helpers/remoteRuntimeFixture'

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
    const first = await service.request(request())
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
      /^create -p .*\/envs\/[a-f0-9]{64} --override-channels -c conda-forge --yes/u
    )
    assert.doesNotMatch(calls[0] ?? '', /-c bioconda/u)
    assert.match(calls[0] ?? '', new RegExp(`root=${escapeRegExp(fixture.runtimeRoot)}$`))
    assert.equal(existsSync(join(fixture.localAnchor, '.phi')), false)
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
    assert.match(result.error, /设置.+安装 micromamba/u)
    assert.match(result.error, /没有.+本机/u)
    assert.equal(readFileSync(join(fixture.localAnchor, 'sentinel.txt'), 'utf8'), 'untouched')
    assert.equal(existsSync(join(fixture.runtimeRoot, 'bin', 'micromamba-test')), false)
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
    assert.match(result.error, /超时/u)
  } finally {
    fixture.cleanup()
  }
})

test('remote env_request turns conda connectivity failures into an actionable Chinese error', async () => {
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
    assert.match(result.error, /无法访问 conda/u)
    assert.match(result.error, /镜像/u)
    assert.match(result.error, /可联网机器/u)
    assert.equal(existsSync(join(fixture.localAnchor, '.phi')), false)
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
    assert.match(result.error, /取消/u)
  } finally {
    fixture.cleanup()
  }
})
