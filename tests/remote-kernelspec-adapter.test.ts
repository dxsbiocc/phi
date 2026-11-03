import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import type { EnvRequestResult } from '../src/main/agent/content/env-request'
import {
  parseDetectedRemoteJupyter,
  RemoteKernelspecAdapter,
  type ResolveMissingRemoteJupyter
} from '../src/main/agent/notebook/remote-kernelspec-adapter'
import { resolveRemoteBaseEnvironment } from '../src/main/agent/remote-runtime/base-environment'
import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'
import type { RemoteJupyterStartJobStepMetadata } from '../src/shared/remoteJupyterJobTypes'
import { warmExecutable } from './helpers/firstExec'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  readFakeMicromambaInvocations,
  WARM_ARG,
  type RemoteRuntimeFixture
} from './helpers/remoteRuntimeFixture'

/** First line of every fake server command: lets the fixture pay the first-exec scan. */
const WARM_LINE = `[ "$1" = ${WARM_ARG} ] && exit 0`

function writeFakeServerCommand(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${WARM_LINE}\n${body}`)
  chmodSync(path, 0o755)
  warmExecutable(path, [WARM_ARG])
}

function createAdapter(
  fixture: RemoteRuntimeFixture,
  options: {
    allowUserPrefixes?: boolean
    configuredJupyterPath?: () => string | undefined
    onConfirmReason?: (reason: string) => void
    resolveMissingJupyter?: ResolveMissingRemoteJupyter
    writeProbeFailure?: 'quota-exceeded' | 'no-space' | 'read-only'
  } = {}
): RemoteKernelspecAdapter {
  const service = new RemoteEnvironmentService({
    micromambaVersion: 'test',
    openWorkspace: async () => fixture.workspace,
    confirm: async (request) => {
      options.onConfirmReason?.(request.reason)
      return true
    },
    ...(options.writeProbeFailure ? { writeProbeFailure: options.writeProbeFailure } : {}),
    resolveBaseEnvironment: (ref, pluginId) =>
      resolveRemoteBaseEnvironment(ref, pluginId, '/unused-agent')
  })
  return new RemoteKernelspecAdapter({
    environments: service,
    openWorkspace: async () => fixture.workspace,
    ...(options.allowUserPrefixes === undefined
      ? {}
      : { allowUserPrefixes: options.allowUserPrefixes }),
    ...(options.configuredJupyterPath
      ? { configuredJupyterPath: options.configuredJupyterPath }
      : {}),
    ...(options.resolveMissingJupyter
      ? { resolveMissingJupyter: options.resolveMissingJupyter }
      : {})
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
    const [invocation] = readFakeMicromambaInvocations(fixture)
    assert.equal(invocation?.env.XDG_CACHE_HOME, join(fixture.runtimeRoot, 'cache'))
    assert.notEqual(invocation?.env.XDG_CACHE_HOME, join(fixture.remoteHome, '.cache'))
    assert.match(calls[0] ?? '', /jupyter_client=8\.10\.0/u)
    assert.match(calls[0] ?? '', /ipykernel=7\.4\.0/u)
  } finally {
    fixture.cleanup()
  }
})

test('remote Jupyter environment approval uses an English reason', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    let reason = ''
    await createAdapter(fixture, {
      onConfirmReason: (value) => {
        reason = value
      }
    }).prepare({ runtimeSessionId: 'runtime-1' })

    assert.equal(reason, 'Prepare a remote Notebook environment with Jupyter Server and ipykernel')
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

test('remote runtime preparation installs managed jupyter only after the resolver chooses install', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    let resolutions = 0
    const adapter = createAdapter(fixture, {
      resolveMissingJupyter: async ({ runtimeSessionId }) => {
        resolutions += 1
        assert.equal(runtimeSessionId, 'runtime-1')
        return { choice: 'install' }
      }
    })

    const prepared = await adapter.prepareRuntime({ runtimeSessionId: 'runtime-1' })

    assert.equal(resolutions, 1)
    const envId = prepared.kernels.kernels[0]?.environment?.envId ?? ''
    assert.equal(
      prepared.launch.command,
      join(fixture.runtimeRoot, 'envs', envId, 'bin', 'jupyter')
    )
    assert.equal(prepared.launch.cwd, fixture.projectRoot)
    assert.deepEqual(prepared.launch.args, [
      'server',
      `--KernelSpecManager.kernel_dirs=${join(fixture.runtimeRoot, 'jupyter', 'kernels')}`,
      '--KernelSpecManager.ensure_native_kernel=False'
    ])
    assert.equal(prepared.launch.env?.JUPYTER_PATH, join(fixture.runtimeRoot, 'jupyter'))
    assert.equal(
      prepared.launch.env?.JUPYTER_RUNTIME_DIR,
      join(fixture.runtimeRoot, 'jupyter', 'runtime')
    )
    assert.doesNotMatch(JSON.stringify(prepared.launch), /token=/iu)
    for (const directory of ['config', 'data', 'runtime']) {
      assert.equal(existsSync(join(fixture.runtimeRoot, 'jupyter', directory)), true)
    }
  } finally {
    fixture.cleanup()
  }
})

test('remote missing-Jupyter card is attributed to the active chat runtime', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    let promptRuntime: string | undefined
    const adapter = createAdapter(fixture, {
      resolveMissingJupyter: async ({ runtimeSessionId }) => {
        promptRuntime = runtimeSessionId
        return { choice: 'cancel' }
      }
    })

    await assert.rejects(
      adapter.prepareRuntime({
        runtimeSessionId: 'notebook:project-1',
        promptRuntimeSessionId: 'runtime-chat-1'
      }),
      /blocked:/
    )
    assert.equal(promptRuntime, 'runtime-chat-1')
  } finally {
    fixture.cleanup()
  }
})

test('a previously installed managed Jupyter environment starts without asking again', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    let resolutions = 0
    const adapter = createAdapter(fixture, {
      resolveMissingJupyter: async () => {
        resolutions += 1
        return resolutions === 1 ? { choice: 'install' } : { choice: 'cancel' }
      }
    })

    const first = await adapter.prepareRuntime({ runtimeSessionId: 'runtime-1' })
    const second = await adapter.prepareRuntime({ runtimeSessionId: 'runtime-1' })

    assert.equal(first.source, 'managed')
    assert.equal(second.source, 'managed')
    assert.equal(resolutions, 1)
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
      /Unable to install the remote Notebook environment with Jupyter \+ ipykernel.+Settings.+micromamba path.+did not fall back.+locally/u
    )
    assert.equal(existsSync(join(fixture.localAnchor, '.phi')), false)
  } finally {
    fixture.cleanup()
  }
})

test('remote Jupyter preparation forwards cancellation to the environment service', async () => {
  let requestId = ''
  let finishRequest!: (result: EnvRequestResult) => void
  const adapter = new RemoteKernelspecAdapter({
    environments: {
      request: (input) => {
        requestId = String((input as { requestId?: unknown }).requestId ?? '')
        return new Promise<EnvRequestResult>((resolve) => {
          finishRequest = resolve
        })
      },
      cancel: (input) => {
        assert.equal((input as { requestId?: unknown }).requestId, requestId)
        finishRequest({ error: '远程环境创建已取消' })
      },
      bindSession: async () => ({ notReady: { message: 'not used' } })
    },
    openWorkspace: async () => {
      throw new Error('cancelled preparation must not open a workspace')
    }
  })
  const controller = new AbortController()
  const preparing = adapter.prepare({ runtimeSessionId: 'runtime-1', signal: controller.signal })

  controller.abort()

  await assert.rejects(preparing, /environment preparation was cancelled/iu)
  assert.match(requestId, /^notebook-/u)
})

test('remote Jupyter preparation keeps the env_request offline-source guidance', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture, 'test', 'offline')
    const adapter = createAdapter(fixture)

    await assert.rejects(
      adapter.prepare({ runtimeSessionId: 'runtime-1' }),
      /Unable to install the remote Notebook environment with Jupyter \+ ipykernel.+cannot reach the conda.+mirror.+machine with network access.+did not fall back/u
    )
    assert.equal(existsSync(join(fixture.localAnchor, '.phi')), false)
  } finally {
    fixture.cleanup()
  }
})

test('remote Jupyter preparation reuses the Phi cache after an online source failure', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture, 'test', 'cached-offline')
    const adapter = createAdapter(fixture)

    const prepared = await adapter.prepare({ runtimeSessionId: 'runtime-1' })

    assert.equal(prepared.kernels[0]?.status, 'ready')
    const calls = readFakeMicromambaInvocations(fixture)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.argv.includes('--offline'), false)
    assert.equal(calls[1]?.argv.includes('--offline'), true)
  } finally {
    fixture.cleanup()
  }
})

test('remote Jupyter preparation surfaces a silent runtime-root quota failure', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture, 'test', 'silent')
    const adapter = createAdapter(fixture, { writeProbeFailure: 'quota-exceeded' })

    await assert.rejects(
      adapter.prepare({ runtimeSessionId: 'runtime-1' }),
      /Unable to install the remote Notebook environment with Jupyter \+ ipykernel.+Disk space or the file count quota is exhausted.+Settings → Remote Hosts/u
    )
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
      /Unable to install the remote Notebook environment with Jupyter \+ ipykernel.+micromamba environment creation failed on the server: solver failed/u
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
    assert.throws(() => adapter.select(listed, 'python3'), /is unavailable/u)
    const unmanaged = { ...listed.kernels[0]!, name: 'host-research', source: 'host' as const }
    const unsafeDefault = {
      ...listed,
      kernels: [...listed.kernels, unmanaged],
      preferredKernelName: unmanaged.name
    }
    assert.throws(() => adapter.select(unsafeDefault), /is unavailable/u)
    assert.throws(() => adapter.select(unsafeDefault, unmanaged.name), /is unavailable/u)
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
      /user prefixes are disabled/u
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
    writeFakeServerCommand(python, '[ "$1" = -c ] && [ "$2" = "import ipykernel" ]\n')
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
    writeFakeServerCommand(python, 'exit 3\n')
    const adapter = createAdapter(fixture, { allowUserPrefixes: true })

    await assert.rejects(
      adapter.registerUserPrefix({
        runtimeSessionId: 'runtime-1',
        name: 'missing-kernel',
        prefix
      }),
      (error: unknown) =>
        error instanceof Error &&
        /does not have a usable ipykernel/u.test(error.message) &&
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

function installFakeServerJupyter(
  prefix: string,
  options: { ipykernel?: boolean; version?: string } = {}
): { jupyter: string; python: string } {
  const bin = join(prefix, 'bin')
  mkdirSync(bin, { recursive: true })
  const jupyter = join(bin, 'jupyter')
  const python = join(bin, 'python')
  writeFakeServerCommand(
    jupyter,
    `if [ "$1 $2" = "server --version" ]; then echo ${options.version ?? '2.14.2'}; exit 0; fi\nexit 1\n`
  )
  writeFakeServerCommand(
    python,
    `if [ "$1 $2" = "-c import ipykernel" ]; then exit ${options.ipykernel === false ? 1 : 0}; fi\nexit 1\n`
  )
  return { jupyter, python }
}

test('a resolver-selected server Jupyter with ipykernel is used without building an environment', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const existing = installFakeServerJupyter(join(fixture.remoteHome, 'miniconda3'))
    const progress: Array<{ text: string; metadata?: RemoteJupyterStartJobStepMetadata }> = []
    const prepared = await createAdapter(fixture, {
      resolveMissingJupyter: async () => ({ choice: 'path', path: existing.jupyter })
    }).prepareRuntime({
      runtimeSessionId: 'runtime-1',
      onProgress: (text, metadata) => progress.push({ text, metadata })
    })

    assert.equal(prepared.source, 'existing')
    assert.equal(prepared.launch.command, existing.jupyter)
    assert.ok(prepared.launch.args)
    assert.equal(prepared.launch.args[0], 'server')
    assert.equal(prepared.kernels.preferredKernelName, 'server-python')
    assert.equal(prepared.kernels.jupyterServer.version, '2.14.2')
    assert.equal(prepared.kernels.kernels[0]?.displayName, 'Python (服务器现有环境)')
    assert.equal(createAdapter(fixture).select(prepared.kernels).name, 'server-python')
    const spec = JSON.parse(
      readFileSync(
        join(fixture.runtimeRoot, 'jupyter', 'kernels', 'server-python', 'kernel.json'),
        'utf8'
      )
    ) as { argv: string[] }
    assert.equal(spec.argv[0], existing.python)
    assert.equal(existsSync(join(fixture.runtimeRoot, 'micromamba-calls.log')), false)
    assert.deepEqual(
      progress.find((event) => event.metadata?.code === 'checking_configured_jupyter'),
      {
        text: `Checking Jupyter path ${existing.jupyter} and the server login shell's PATH…`,
        metadata: {
          code: 'checking_configured_jupyter',
          params: { configuredPath: existing.jupyter }
        }
      }
    )
    assert.deepEqual(
      progress.find((event) => event.metadata?.code === 'using_existing_jupyter'),
      {
        text: `Using existing server Jupyter: ${existing.jupyter} (jupyter_server 2.14.2); kernel Python: ${existing.python}`,
        metadata: {
          code: 'using_existing_jupyter',
          params: {
            jupyterPath: existing.jupyter,
            pythonPath: existing.python,
            version: '2.14.2'
          }
        }
      }
    )
  } finally {
    fixture.cleanup()
  }
})

test('the configured Jupyter path wins over one found elsewhere on the server', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeServerJupyter(join(fixture.remoteHome, 'miniconda3'))
    const configured = installFakeServerJupyter(join(fixture.remoteHome, 'tools'), {
      version: '2.15.0'
    })
    const service = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true
    })
    const adapter = new RemoteKernelspecAdapter({
      environments: service,
      openWorkspace: async () => fixture.workspace,
      configuredJupyterPath: () => configured.jupyter
    })
    const prepared = await adapter.prepareRuntime({ runtimeSessionId: 'runtime-1' })
    assert.equal(prepared.launch.command, configured.jupyter)
    assert.equal(prepared.kernels.jupyterServer.version, '2.15.0')
  } finally {
    fixture.cleanup()
  }
})

test('a resolver-selected absolute Jupyter path is revalidated and used without installation', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const selected = installFakeServerJupyter(join(fixture.root, 'custom', 'jupyter-env'))
    const controller = new AbortController()
    let resolutions = 0
    const adapter = createAdapter(fixture, {
      resolveMissingJupyter: async (context) => {
        resolutions += 1
        assert.equal(context.runtimeSessionId, 'runtime-path')
        assert.equal(context.signal, controller.signal)
        return { choice: 'path', path: selected.jupyter }
      }
    })

    const prepared = await adapter.prepareRuntime({
      runtimeSessionId: 'runtime-path',
      signal: controller.signal
    })

    assert.equal(resolutions, 1)
    assert.equal(prepared.source, 'existing')
    assert.equal(prepared.launch.command, selected.jupyter)
    assert.equal(existsSync(join(fixture.runtimeRoot, 'micromamba-calls.log')), false)
  } finally {
    fixture.cleanup()
  }
})

test('a server Jupyter whose Python lacks ipykernel installs only after an explicit install choice', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    installFakeServerJupyter(join(fixture.remoteHome, 'miniconda3'), { ipykernel: false })
    const progress: Array<{ text: string; metadata?: RemoteJupyterStartJobStepMetadata }> = []
    const prepared = await createAdapter(fixture, {
      resolveMissingJupyter: async () => ({ choice: 'install' })
    }).prepareRuntime({
      runtimeSessionId: 'runtime-1',
      onProgress: (text, metadata) => progress.push({ text, metadata })
    })
    assert.equal(prepared.source, 'managed')
    assert.equal(prepared.kernels.preferredKernelName, 'phi-python')
    assert.deepEqual(
      progress.filter((event) => event.metadata).map((event) => event.metadata?.code),
      ['checking_server_path_jupyter', 'missing_jupyter_using_managed', 'using_managed_jupyter']
    )
    assert.match(
      progress.find((event) => event.metadata?.code === 'using_managed_jupyter')?.text ?? '',
      /^Using Jupyter from the managed environment: \/.*\/bin\/jupyter$/u
    )
  } finally {
    fixture.cleanup()
  }
})

test('cancelling missing Jupyter recovery blocks startup without requesting an environment', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    let resolutions = 0
    const adapter = createAdapter(fixture, {
      resolveMissingJupyter: async () => {
        resolutions += 1
        return { choice: 'cancel' }
      }
    })

    await assert.rejects(
      adapter.prepareRuntime({ runtimeSessionId: 'runtime-cancel' }),
      /blocked:.+Jupyter.+cancelled.+did not install/iu
    )
    assert.equal(resolutions, 1)
    assert.equal(existsSync(join(fixture.runtimeRoot, 'micromamba-calls.log')), false)
  } finally {
    fixture.cleanup()
  }
})

test('an invalid resolver-selected Jupyter path is blocked without requesting an environment', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const adapter = createAdapter(fixture, {
      resolveMissingJupyter: async () => ({ choice: 'path', path: 'relative/bin/jupyter' })
    })

    await assert.rejects(
      adapter.prepareRuntime({ runtimeSessionId: 'runtime-invalid' }),
      /blocked:.+absolute remote path.+did not install/iu
    )
    assert.equal(existsSync(join(fixture.runtimeRoot, 'micromamba-calls.log')), false)
  } finally {
    fixture.cleanup()
  }
})

test('an unusable absolute resolver-selected Jupyter path is blocked without installation', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const unusable = installFakeServerJupyter(join(fixture.root, 'bad', 'jupyter-env'), {
      ipykernel: false
    })
    const adapter = createAdapter(fixture, {
      resolveMissingJupyter: async () => ({ choice: 'path', path: unusable.jupyter })
    })

    await assert.rejects(
      adapter.prepareRuntime({ runtimeSessionId: 'runtime-unusable' }),
      /blocked:.+not a usable Jupyter Server with ipykernel.+did not install/iu
    )
    assert.equal(existsSync(join(fixture.runtimeRoot, 'micromamba-calls.log')), false)
  } finally {
    fixture.cleanup()
  }
})

test('missing Jupyter never installs by default when no resolver is configured', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    installFakeMicromamba(fixture)
    const adapter = createAdapter(fixture)

    await assert.rejects(
      adapter.prepareRuntime({ runtimeSessionId: 'runtime-no-resolver' }),
      /blocked:.+Jupyter.+no missing-tool resolver.+did not install/iu
    )
    assert.equal(existsSync(join(fixture.runtimeRoot, 'micromamba-calls.log')), false)
  } finally {
    fixture.cleanup()
  }
})

test('detection output is accepted only with absolute paths', () => {
  assert.deepEqual(
    parseDetectedRemoteJupyter('noise\nPHI_JUPYTER\t/opt/bin/jupyter\t/opt/bin/python\t2.1\n'),
    {
      jupyter: '/opt/bin/jupyter',
      python: '/opt/bin/python',
      version: '2.1'
    }
  )
  assert.equal(parseDetectedRemoteJupyter('PHI_JUPYTER\tjupyter\t/opt/bin/python\t2.1'), undefined)
  assert.equal(parseDetectedRemoteJupyter(''), undefined)
})
