import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { describeEnvironment } from '../src/main/agent/content/environment-refs'
import { removeTree, type PhiPlatform } from '../src/main/agent/envs'
import {
  DEFAULT_KERNEL_NAME,
  listAnalysisKernels,
  type AnalysisKernelDiagnostics
} from '../src/main/agent/notebook/analysis-kernels'
import {
  AnalysisNotebookSessionRegistry,
  selectNotebookKernel,
  type JupyterSessionClient,
  type JupyterSessionCreateRequest
} from '../src/main/agent/notebook/analysis-jupyter-sessions'
import {
  HOST_KERNEL_LABEL,
  NOT_BUILT_KERNEL_LABEL,
  hostKernelArgv,
  managedKernelsDir,
  syncManagedKernels,
  type KernelSpecFile
} from '../src/main/agent/notebook/managed-kernels'
import type { NotebookDocument } from '../src/shared/notebookDocument'
import { copyMinimal, installReady } from './helpers/fakeEnvironment'

const PLATFORM: PhiPlatform = 'darwin-arm64'
const HOST_ENV = {
  HOME: '/Users/someone',
  LANG: 'en_US.UTF-8',
  HTTP_PROXY: 'http://user:secret@proxy:8080',
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  R_LIBS_USER: '/Users/someone/R'
}

interface Fixture {
  root: string
  environmentsDir: string
}

function withFixture(body: (fixture: Fixture) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'phi-managed-kernels-')))
    const fixture = { root: join(base, 'runtime'), environmentsDir: join(base, 'environments') }
    mkdirSync(fixture.root, { recursive: true })
    for (const name of ['phi-python', 'phi-r', 'phi-jupyter']) {
      copyMinimal(join(fixture.environmentsDir, name), name)
    }
    try {
      await body(fixture)
    } finally {
      removeTree(base)
    }
  }
}

function install(fixture: Fixture, ref: string): { envId: string; prefix: string } {
  const descriptor = describeEnvironment(ref, {
    environmentsDir: fixture.environmentsDir,
    platform: PLATFORM
  })
  const envId = installReady(fixture.root, descriptor, {})
  return { envId, prefix: join(fixture.root, 'envs', envId) }
}

function readSpec(fixture: Fixture, name: string): KernelSpecFile {
  return JSON.parse(
    readFileSync(join(managedKernelsDir(fixture.root), name, 'kernel.json'), 'utf8')
  ) as KernelSpecFile
}

function ctx(fixture: Fixture): {
  root: string
  environmentsDir: string
  platform: PhiPlatform
  baseEnv: NodeJS.ProcessEnv
  hostPlatform: NodeJS.Platform
} {
  return {
    root: fixture.root,
    environmentsDir: fixture.environmentsDir,
    platform: PLATFORM,
    baseEnv: HOST_ENV,
    hostPlatform: 'darwin'
  }
}

function hostKernelspecs(dir: string): string {
  const python = join(dir, 'python3')
  const ir = join(dir, 'ir')
  mkdirSync(python, { recursive: true })
  mkdirSync(ir, { recursive: true })
  writeFileSync(
    join(python, 'kernel.json'),
    JSON.stringify({
      argv: ['/opt/conda/bin/python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      display_name: 'Python 3 (ipykernel)',
      language: 'python'
    })
  )
  writeFileSync(join(python, 'logo-64x64.png'), 'png')
  writeFileSync(
    join(ir, 'kernel.json'),
    JSON.stringify({
      argv: ['R', '--slave', '-e', 'IRkernel::main()', '--args', '{connection_file}'],
      display_name: 'R',
      language: 'R'
    })
  )
  return JSON.stringify({
    kernelspecs: {
      python3: {
        resource_dir: python,
        spec: { display_name: 'Python 3 (ipykernel)', language: 'python', argv: ['python'] }
      },
      ir: { resource_dir: ir, spec: { display_name: 'R', language: 'R', argv: ['R'] } }
    }
  })
}

function hostRunner(listing: string): (command: string, args: string[]) => string {
  return (_command, args) => (args[0] === 'server' ? '2.14.0\n' : listing)
}

function notebook(kernelspec?: Record<string, string>, language?: string): NotebookDocument {
  const metadata: Record<string, unknown> = {}
  if (kernelspec) metadata.kernelspec = kernelspec
  if (language) metadata.language_info = { name: language }
  return { cells: [], metadata, nbformat: 4, nbformatMinor: 5 } as unknown as NotebookDocument
}

test(
  'syncManagedKernels writes phi-python with the prefix interpreter and the environment variables',
  withFixture((fixture) => {
    const { envId, prefix } = install(fixture, 'phi:python@1')
    const states = syncManagedKernels(ctx(fixture))
    const python = states.find((state) => state.definition.name === 'phi-python')
    assert.equal(python?.status, 'ready')

    const spec = readSpec(fixture, 'phi-python')
    assert.deepEqual(spec.argv, [
      join(prefix, 'bin', 'python'),
      '-m',
      'ipykernel_launcher',
      '-f',
      '{connection_file}'
    ])
    assert.equal(spec.language, 'python')
    assert.equal(spec.display_name, 'Python 3.12 (phi-python)')
    const env = spec.env ?? {}
    assert.equal(env.PHI_ENV_ID, envId)
    assert.equal(env.PHI_ENV_PREFIX, prefix)
    assert.equal(env.PYTHONNOUSERSITE, '1')
    assert.equal(env.R_LIBS_USER, join(prefix, 'lib', 'R', 'library'))
    assert.equal(env.PATH, `${join(prefix, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`)
    assert.equal(env.MPLBACKEND, 'module://matplotlib_inline.backend_inline')
    assert.equal(env.MPLCONFIGDIR, join(fixture.root, 'cache', envId, 'matplotlib'))
    assert.equal(env.LANG, 'en_US.UTF-8')
    // Kept host variables come from the server's environment, never written to disk here.
    assert.equal(env.HTTP_PROXY, undefined)
    assert.equal(env.HOME, undefined)
    assert.deepEqual(spec.metadata?.phi, { managed: true, ref: 'phi:python@1', envId })
  })
)

test(
  'phi-r uses the prefix R with IRkernel installed argv, or the documented default',
  withFixture((fixture) => {
    const { envId, prefix } = install(fixture, 'phi:r@1')
    syncManagedKernels(ctx(fixture))
    assert.deepEqual(readSpec(fixture, 'phi-r').argv, [
      join(prefix, 'bin', 'R'),
      '--slave',
      '-e',
      'IRkernel::main()',
      '--args',
      '{connection_file}'
    ])

    const installed = join(prefix, 'share', 'jupyter', 'kernels', 'ir')
    mkdirSync(installed, { recursive: true })
    writeFileSync(
      join(installed, 'kernel.json'),
      JSON.stringify({
        argv: ['R', '--no-echo', '-e', 'IRkernel::main()', '--args', '{connection_file}']
      })
    )
    syncManagedKernels(ctx(fixture))
    const spec = readSpec(fixture, 'phi-r')
    assert.deepEqual(spec.argv, [
      join(prefix, 'bin', 'R'),
      '--no-echo',
      '-e',
      'IRkernel::main()',
      '--args',
      '{connection_file}'
    ])
    assert.equal(spec.language, 'R')
    assert.equal(spec.env?.PHI_ENV_ID, envId)
    assert.equal(spec.env?.R_PROFILE_USER, '/dev/null')
    assert.equal(spec.env?.MPLBACKEND, 'Agg')
  })
)

test(
  'a kernel whose environment is not built has no spec and is reported not built',
  withFixture((fixture) => {
    const stale = join(managedKernelsDir(fixture.root), 'phi-r')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'kernel.json'), '{"argv":["/gone/bin/R"]}')
    const states = syncManagedKernels(ctx(fixture))
    const r = states.find((state) => state.definition.name === 'phi-r')
    assert.equal(r?.status, 'not-built')
    assert.equal(
      r?.status === 'not-built' ? r.message : '',
      'environment phi:r@1 is not ready; the user must build it first'
    )
    assert.equal(existsSync(stale), false)
  })
)

test(
  'specs are rewritten when the environment envId changes',
  withFixture((fixture) => {
    const first = install(fixture, 'phi:python@1')
    syncManagedKernels(ctx(fixture))
    assert.equal(readSpec(fixture, 'phi-python').env?.PHI_ENV_ID, first.envId)

    // A new lock (one more package) is a new envId.
    const lock = join(fixture.environmentsDir, 'phi-python', 'locks', `${PLATFORM}.txt`)
    writeFileSync(
      lock,
      `${readFileSync(lock, 'utf8').trimEnd()}\nhttps://conda.anaconda.org/conda-forge/noarch/extra-1.0-0.conda#${'a'.repeat(32)}\n`
    )
    const second = install(fixture, 'phi:python@1')
    assert.notEqual(second.envId, first.envId)
    syncManagedKernels(ctx(fixture))
    const spec = readSpec(fixture, 'phi-python')
    assert.equal(spec.env?.PHI_ENV_ID, second.envId)
    assert.equal(spec.argv[0], join(second.prefix, 'bin', 'python'))
  })
)

test(
  'listAnalysisKernels lists managed kernels first, phi-python default, host kernels labelled',
  withFixture((fixture) => {
    install(fixture, 'phi:python@1')
    install(fixture, 'phi:jupyter@1')
    const hostDir = join(fixture.root, '..', 'host-kernels')
    const diagnostics = listAnalysisKernels({
      ...ctx(fixture),
      hostRunner: hostRunner(hostKernelspecs(hostDir))
    })

    assert.equal(diagnostics.jupyterServer.available, true)
    assert.equal(diagnostics.jupyterServer.managed, true)
    assert.equal(diagnostics.preferredKernelName, DEFAULT_KERNEL_NAME)
    assert.deepEqual(
      diagnostics.kernels.map((kernel) => [
        kernel.name,
        kernel.source,
        kernel.status,
        kernel.label
      ]),
      [
        ['phi-python', 'managed', 'ready', undefined],
        ['phi-r', 'managed', 'not-built', NOT_BUILT_KERNEL_LABEL],
        ['host-python3', 'host', 'ready', HOST_KERNEL_LABEL],
        ['host-ir', 'host', 'ready', HOST_KERNEL_LABEL]
      ]
    )
    const host = diagnostics.kernels.find((kernel) => kernel.name === 'host-python3')
    assert.equal(host?.hostName, 'python3')
    assert.equal(host?.displayName, `Python 3 (ipykernel) · ${HOST_KERNEL_LABEL}`)
    // Old fields are still present.
    assert.equal(host?.language, 'python')
    assert.equal(host?.rawLanguage, 'python')
    assert.equal(diagnostics.hasPythonKernel, true)
    assert.equal(diagnostics.hasRKernel, true)
    assert.match(diagnostics.messages.join('\n'), /R 4\.4 \(phi-r\): not built/)

    // The host copy runs the host argv with the host PATH and without Phi's isolation.
    const copy = readSpec(fixture, 'host-python3')
    assert.deepEqual(copy.argv.slice(-5), [
      '/opt/conda/bin/python',
      '-m',
      'ipykernel_launcher',
      '-f',
      '{connection_file}'
    ])
    assert.equal(copy.argv[0], '/usr/bin/env')
    assert.ok(copy.argv.includes(`PATH=${HOST_ENV.PATH}`))
    assert.ok(copy.argv.includes(`R_LIBS_USER=${HOST_ENV.R_LIBS_USER}`))
    assert.deepEqual(
      copy.argv.slice(copy.argv.indexOf('PHI_ENV_ID') - 1, copy.argv.indexOf('PHI_ENV_ID') + 1),
      ['-u', 'PHI_ENV_ID']
    )
    assert.equal(copy.display_name, `Python 3 (ipykernel) · ${HOST_KERNEL_LABEL}`)
    assert.ok(existsSync(join(managedKernelsDir(fixture.root), 'host-python3', 'logo-64x64.png')))
  })
)

test(
  'host kernels that disappear are removed; a missing host jupyter only drops host kernels',
  withFixture((fixture) => {
    install(fixture, 'phi:python@1')
    const hostDir = join(fixture.root, '..', 'host-kernels')
    listAnalysisKernels({ ...ctx(fixture), hostRunner: hostRunner(hostKernelspecs(hostDir)) })
    assert.ok(existsSync(join(managedKernelsDir(fixture.root), 'host-ir')))

    const diagnostics = listAnalysisKernels({
      ...ctx(fixture),
      hostRunner: () => {
        throw new Error('ENOENT jupyter')
      }
    })
    assert.deepEqual(
      diagnostics.kernels.map((kernel) => kernel.name),
      ['phi-python', 'phi-r']
    )
    assert.equal(existsSync(join(managedKernelsDir(fixture.root), 'host-ir')), false)
    assert.equal(diagnostics.jupyterServer.available, false)
    assert.equal(
      diagnostics.jupyterServer.error,
      'environment phi:jupyter@1 is not ready; the user must build it first'
    )

    const skipped = listAnalysisKernels({
      ...ctx(fixture),
      hostJupyterCommand: null,
      hostRunner: () => {
        throw new Error('must not probe the host')
      }
    })
    assert.deepEqual(
      skipped.kernels.map((kernel) => kernel.source),
      ['managed', 'managed']
    )
  })
)

test('hostKernelArgv unsets isolation variables the host does not set', () => {
  const argv = hostKernelArgv(['python', '-m', 'ipykernel_launcher'], {
    PATH: '/usr/bin',
    LC_ALL: 'C'
  })
  assert.equal(argv[0], '/usr/bin/env')
  assert.ok(argv.includes('LC_ALL=C'))
  assert.ok(argv.includes('PATH=/usr/bin'))
  for (const name of [
    'PYTHONNOUSERSITE',
    'MPLBACKEND',
    'R_LIBS_USER',
    'CONDA_PREFIX',
    'PHI_ENV_PREFIX'
  ]) {
    assert.equal(argv[argv.indexOf(name) - 1], '-u', name)
  }
  assert.deepEqual(argv.slice(-3), ['python', '-m', 'ipykernel_launcher'])
})

function diagnosticsOf(kernels: AnalysisKernelDiagnostics['kernels']): AnalysisKernelDiagnostics {
  return {
    jupyterServer: { available: true, command: 'jupyter' },
    kernels,
    preferredKernelName: DEFAULT_KERNEL_NAME,
    hasPythonKernel: true,
    hasRKernel: true,
    messages: []
  }
}

const MANAGED_PYTHON = {
  name: 'phi-python',
  displayName: 'Python 3.12 (phi-python)',
  language: 'python' as const,
  rawLanguage: 'python',
  source: 'managed' as const,
  status: 'ready' as const,
  environment: { ref: 'phi:python@1' }
}
const MANAGED_R = {
  name: 'phi-r',
  displayName: 'R 4.4 (phi-r)',
  language: 'r' as const,
  rawLanguage: 'R',
  source: 'managed' as const,
  status: 'not-built' as const,
  label: NOT_BUILT_KERNEL_LABEL,
  environment: { ref: 'phi:r@1' }
}
const HOST_PYTHON = {
  name: 'host-python3',
  hostName: 'python3',
  displayName: `Python 3 (ipykernel) · ${HOST_KERNEL_LABEL}`,
  language: 'python' as const,
  rawLanguage: 'python',
  source: 'host' as const,
  status: 'ready' as const,
  label: HOST_KERNEL_LABEL
}

test('default kernel selection is managed; a host kernel only by its exact name', () => {
  const all = diagnosticsOf([HOST_PYTHON, MANAGED_PYTHON, MANAGED_R])
  assert.equal(selectNotebookKernel(notebook(), all)?.name, 'phi-python')
  // Old notebooks name the host kernel `python3`: that is not an explicit choice.
  assert.equal(
    selectNotebookKernel(
      notebook({ name: 'python3', display_name: 'Python 3 (ipykernel)' }, 'python'),
      all
    )?.name,
    'phi-python'
  )
  assert.equal(
    selectNotebookKernel(notebook({ display_name: HOST_PYTHON.displayName }), all)?.name,
    'phi-python'
  )
  assert.equal(selectNotebookKernel(notebook({ name: 'host-python3' }), all)?.name, 'host-python3')
  assert.equal(selectNotebookKernel(notebook(undefined, 'R'), all)?.name, 'phi-r')
  // Only host kernels: none is picked by default.
  assert.equal(
    selectNotebookKernel(notebook(undefined, 'python'), diagnosticsOf([HOST_PYTHON])),
    null
  )
  assert.equal(selectNotebookKernel(notebook(), diagnosticsOf([HOST_PYTHON])), null)
})

class RecordingClient implements JupyterSessionClient {
  readonly created: JupyterSessionCreateRequest[] = []

  async createSession(
    _connection: unknown,
    request: JupyterSessionCreateRequest
  ): Promise<{ id: string; kernelId: string; kernelName: string; executionState: string }> {
    this.created.push(request)
    return { id: 's1', kernelId: 'k1', kernelName: request.kernelName, executionState: 'idle' }
  }

  async deleteSession(): Promise<void> {
    return undefined
  }

  async interruptKernel(): Promise<void> {
    return undefined
  }
}

test('selecting a not-built kernel goes through prepareKernel, never straight to the server', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'phi-managed-kernels-project-')))
  try {
    const input = {
      projectCwd: project,
      notebookPath: join(project, 'a.ipynb'),
      document: notebook({ name: 'phi-r' }),
      kernels: diagnosticsOf([MANAGED_PYTHON, MANAGED_R])
    }
    const connection = (): { url: string } => ({ url: 'http://127.0.0.1:1/' })

    const plain = new RecordingClient()
    const withoutPrompt = new AnalysisNotebookSessionRegistry({
      getConnection: connection,
      client: plain
    })
    const status = await withoutPrompt.ensureSession(input)
    assert.equal(status.state, 'missing')
    assert.equal(status.message, 'environment phi:r@1 is not ready; the user must build it first')
    assert.equal(withoutPrompt.status(input).message, status.message)
    assert.equal(plain.created.length, 0)

    const declined = new RecordingClient()
    const declining = new AnalysisNotebookSessionRegistry({
      getConnection: connection,
      client: declined,
      prepareKernel: async () => ({
        ready: false,
        message: 'environment phi:r@1 is not built; the user declined to build it now'
      })
    })
    assert.match((await declining.ensureSession(input)).message ?? '', /declined/)
    assert.equal(declined.created.length, 0)

    const prepared: string[] = []
    const built = new RecordingClient()
    const building = new AnalysisNotebookSessionRegistry({
      getConnection: connection,
      client: built,
      prepareKernel: async (kernel) => {
        prepared.push(kernel.name)
        return { ready: true }
      }
    })
    const connected = await building.ensureSession(input)
    assert.deepEqual(prepared, ['phi-r'])
    assert.equal(connected.state, 'idle')
    assert.deepEqual(
      built.created.map((request) => request.kernelName),
      ['phi-r']
    )
  } finally {
    removeTree(project)
  }
})
