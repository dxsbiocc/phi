import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { RemoteKernelspecAdapter } from '../src/main/agent/notebook/remote-kernelspec-adapter'
import { resolveRemoteBaseEnvironment } from '../src/main/agent/remote-runtime/base-environment'
import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  type RemoteRuntimeFixture
} from './helpers/remoteRuntimeFixture'

function createAdapter(
  fixture: RemoteRuntimeFixture,
  options: { allowUserPrefixes?: boolean } = {}
): RemoteKernelspecAdapter {
  const service = new RemoteEnvironmentService({
    micromambaVersion: 'test',
    openWorkspace: async () => fixture.workspace,
    confirm: async () => true,
    resolveBaseEnvironment: (ref, pluginId) =>
      resolveRemoteBaseEnvironment(ref, pluginId, '/unused-agent')
  })
  return new RemoteKernelspecAdapter({
    environments: service,
    openWorkspace: async () => fixture.workspace,
    ...(options.allowUserPrefixes === undefined
      ? {}
      : { allowUserPrefixes: options.allowUserPrefixes })
  })
}

test('remote Jupyter environment is created once and reused by content hash', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const adapter = createAdapter(fixture)

    const first = await adapter.prepare({
      runtimeSessionId: 'runtime-1',
      requestId: 'jupyter-1'
    })
    const second = await adapter.prepare({
      runtimeSessionId: 'runtime-1',
      requestId: 'jupyter-2'
    })

    assert.equal(first.kernels[0]?.name, 'phi-python')
    assert.equal(first.kernels[0]?.status, 'ready')
    assert.equal(first.kernels[0]?.environment?.envId, second.kernels[0]?.environment?.envId)
    const envId = first.kernels[0]?.environment?.envId ?? ''
    assert.equal(
      existsSync(join(fixture.runtimeRoot, 'envs', envId, 'conda-meta', 'history')),
      true
    )
    const calls = readFileSync(join(fixture.runtimeRoot, 'micromamba-calls.log'), 'utf8')
      .trim()
      .split('\n')
    assert.equal(calls.length, 1)
    assert.match(calls[0] ?? '', /jupyter_server=2\.21\.1/u)
    assert.match(calls[0] ?? '', /jupyter_client=8\.10\.0/u)
    assert.match(calls[0] ?? '', /ipykernel=7\.4\.0/u)
  } finally {
    fixture.cleanup()
  }
})

test('remote kernelspec listing returns the notebook shape and writes only server argv', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const adapter = createAdapter(fixture)
    const prepared = await adapter.prepare({ runtimeSessionId: 'runtime-1' })

    const listed = await adapter.list({ runtimeSessionId: 'runtime-1' })

    assert.deepEqual(listed, prepared)
    assert.equal(listed.preferredKernelName, 'phi-python')
    assert.equal(listed.hasPythonKernel, true)
    assert.equal(listed.hasRKernel, false)
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(fixture.runtimeRoot))
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(fixture.localAnchor))
    const envId = listed.kernels[0]?.environment?.envId ?? ''
    const specPath = join(fixture.runtimeRoot, 'jupyter', 'kernels', 'phi-python', 'kernel.json')
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { argv: string[] }
    assert.equal(spec.argv[0], join(fixture.runtimeRoot, 'envs', envId, 'bin', 'python'))
    assert.doesNotMatch(JSON.stringify(spec), new RegExp(fixture.localAnchor))
  } finally {
    fixture.cleanup()
  }
})

test('remote Jupyter preparation keeps the env_request missing-micromamba guidance', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const adapter = createAdapter(fixture)

    await assert.rejects(
      adapter.prepare({ runtimeSessionId: 'runtime-1' }),
      /无法安装含 Jupyter \+ ipykernel.+设置.+micromamba 路径.+没有.+本机/u
    )
    assert.equal(existsSync(join(fixture.localAnchor, '.phi')), false)
  } finally {
    fixture.cleanup()
  }
})

test('remote Jupyter preparation keeps the env_request offline-source guidance', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture, 'test', 'offline')
    const adapter = createAdapter(fixture)

    await assert.rejects(
      adapter.prepare({ runtimeSessionId: 'runtime-1' }),
      /无法安装含 Jupyter \+ ipykernel.+无法访问 conda.+镜像.+可联网机器.+没有回退/u
    )
    assert.equal(existsSync(join(fixture.localAnchor, '.phi')), false)
  } finally {
    fixture.cleanup()
  }
})

test('remote Jupyter preparation keeps the env_request environment-creation error', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const binary = installFakeMicromamba(fixture)
    writeFileSync(binary, '#!/bin/sh\necho "solver failed" >&2\nexit 42\n')
    chmodSync(binary, 0o755)
    const adapter = createAdapter(fixture)

    await assert.rejects(
      adapter.prepare({ runtimeSessionId: 'runtime-1' }),
      /无法安装含 Jupyter \+ ipykernel.+micromamba 创建环境失败：solver failed/u
    )
    assert.equal(existsSync(join(fixture.localAnchor, '.phi')), false)
  } finally {
    fixture.cleanup()
  }
})

test('remote kernel selection defaults to the managed phi-python kernel', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const adapter = createAdapter(fixture)
    const listed = await adapter.prepare({ runtimeSessionId: 'runtime-1' })

    assert.equal(adapter.select(listed).name, 'phi-python')
    assert.equal(adapter.select(listed, 'phi-python').source, 'managed')
    assert.throws(() => adapter.select(listed, 'python3'), /不可用/u)
    const unmanaged = { ...listed.kernels[0]!, name: 'host-research', source: 'host' as const }
    const unsafeDefault = {
      ...listed,
      kernels: [...listed.kernels, unmanaged],
      preferredKernelName: unmanaged.name
    }
    assert.throws(() => adapter.select(unsafeDefault), /不可用/u)
    assert.throws(() => adapter.select(unsafeDefault, unmanaged.name), /不可用/u)
  } finally {
    fixture.cleanup()
  }
})

test('remote user prefixes are rejected while the explicit opt-in switch is off', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const stale = join(fixture.runtimeRoot, 'jupyter', 'kernels', 'host-research')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'kernel.json'), '{}\n')
    const adapter = createAdapter(fixture)

    await adapter.prepare({ runtimeSessionId: 'runtime-1' })

    await assert.rejects(
      adapter.registerUserPrefix({
        runtimeSessionId: 'runtime-1',
        name: 'research',
        prefix: '/srv/users/private-name/conda/envs/research'
      }),
      /用户 prefix.+默认关闭/u
    )
    assert.equal(
      existsSync(join(fixture.runtimeRoot, 'jupyter', 'kernels', 'host-research')),
      false
    )
  } finally {
    fixture.cleanup()
  }
})

test('an opted-in user prefix is listed only after its ipykernel dependency check passes', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const prefix = join(fixture.root, 'server-users', 'private-name', 'research')
    const python = join(prefix, 'bin', 'python')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    writeFileSync(python, '#!/bin/sh\n[ "$1" = -c ] && [ "$2" = "import ipykernel" ]\n')
    chmodSync(python, 0o755)
    const adapter = createAdapter(fixture, { allowUserPrefixes: true })

    const kernel = await adapter.registerUserPrefix({
      runtimeSessionId: 'runtime-1',
      name: 'research',
      prefix
    })

    assert.equal(kernel.name, 'host-research')
    assert.equal(kernel.source, 'host')
    assert.doesNotMatch(JSON.stringify(kernel), new RegExp(prefix))
    const specPath = join(fixture.runtimeRoot, 'jupyter', 'kernels', 'host-research', 'kernel.json')
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { argv: string[] }
    assert.equal(spec.argv[0], python)
  } finally {
    fixture.cleanup()
  }
})

test('an opted-in user prefix without ipykernel is not registered or exposed in errors', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const prefix = join(fixture.root, 'server-users', 'private-name', 'missing-kernel')
    const python = join(prefix, 'bin', 'python')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    writeFileSync(python, '#!/bin/sh\nexit 3\n')
    chmodSync(python, 0o755)
    const adapter = createAdapter(fixture, { allowUserPrefixes: true })

    await assert.rejects(
      adapter.registerUserPrefix({
        runtimeSessionId: 'runtime-1',
        name: 'missing-kernel',
        prefix
      }),
      (error: unknown) =>
        error instanceof Error &&
        /缺少可用的 ipykernel/u.test(error.message) &&
        !error.message.includes(prefix)
    )
    assert.equal(
      existsSync(join(fixture.runtimeRoot, 'jupyter', 'kernels', 'host-missing-kernel')),
      false
    )
  } finally {
    fixture.cleanup()
  }
})
