import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'
import { AnalysisNotebookSessionRegistry } from '../src/main/agent/notebook/analysis-jupyter-sessions'
import type { JupyterSessionClient } from '../src/main/agent/notebook/analysis-jupyter-sessions'
import { RemoteJupyterRuntimeBackend } from '../src/main/agent/notebook/jupyter-runtime-backend'
import { RemoteKernelspecAdapter } from '../src/main/agent/notebook/remote-kernelspec-adapter'
import {
  RemoteJupyterServerSupervisor,
  type RemoteJupyterLaunchCommand
} from '../src/main/agent/notebook/remote-jupyter-server'
import {
  openRemoteJupyterLease,
  type OpenRemoteJupyterLeaseOptions
} from '../src/main/agent/notebook/remote-jupyter-lease'
import { AnalysisNotebookToolExecutor } from '../src/main/agent/notebook/notebook-tool-executor'
import { buildNotebookCustomTools } from '../src/main/agent/notebook/notebook-tools'
import { createNotebookWorkspace } from '../src/main/agent/notebook/notebook-workspace'
import type { SshPortForwardSpawn } from '../src/main/agent/workspace-host/ssh-port-forward'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  type RemoteRuntimeFixture
} from './helpers/remoteRuntimeFixture'
import {
  installRemoteJupyterSetsid,
  writeRemoteJupyterTestExecutables
} from './helpers/remoteJupyterScripts'

const RUNTIME_SESSION = 'remote-notebook-e2e'

type NotebookCustomTool = ReturnType<typeof buildNotebookCustomTools>[number]

function notebookBody(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'phi-python', display_name: 'Remote Python', language: 'python' }
    },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'x = 1'
      }
    ]
  })
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${path}`)
}

function fakeSessionClient(events: string[]): JupyterSessionClient {
  return {
    createSession: async (_connection, request) => {
      events.push(`session:${request.notebookRelativePath}:${request.kernelName}`)
      return {
        id: 'session-1',
        kernelId: 'kernel-1',
        kernelName: request.kernelName,
        executionState: 'idle'
      }
    },
    deleteSession: async () => {
      events.push('delete-session')
    },
    interruptKernel: async () => {
      events.push('interrupt')
    }
  }
}

function fakeNotebookExecutor(events: string[]): never {
  return {
    executeCell: async (input: { cell: { id: string; source: string } }) => {
      events.push(`execute:${input.cell.id}:${input.cell.source}`)
      return {
        cellId: input.cell.id,
        executionCount: 7,
        outputs: [
          {
            outputType: 'stream',
            data: {},
            metadata: {},
            name: 'stdout',
            text: 'remote-output\n',
            extra: {}
          }
        ],
        state: 'idle',
        startedAt: '2026-10-10T00:00:00.000Z',
        completedAt: '2026-10-10T00:00:01.000Z'
      }
    }
  } as never
}

async function callNotebookTool(
  tools: Map<string, NotebookCustomTool>,
  name: string,
  cwd: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  assert.ok(tool, `missing ${name}`)
  const result = await tool.execute(`call-${name}`, params, undefined, {
    sessionManager: { getCwd: () => cwd }
  } as never)
  assert.equal(
    result.isError,
    undefined,
    result.content[0]?.type === 'text' ? result.content[0].text : name
  )
  return result.details as Record<string, unknown>
}

function supervisorFactory(input: {
  root: string
  ssh: string
  pidFile: string
  children: ChildProcessWithoutNullStreams[]
}): (launch: RemoteJupyterLaunchCommand) => RemoteJupyterServerSupervisor {
  const spawnImpl: SshPortForwardSpawn = (_binary, args, options) => {
    const child = spawn(input.ssh, args, options)
    if (args.includes('-L')) input.children.push(child)
    return child
  }
  let localPort = 43000
  let remotePort = 53000
  return (launch) =>
    new RemoteJupyterServerSupervisor({
      connection: { host: 'fake-host' },
      launch,
      spawnImpl,
      openLease: (options: OpenRemoteJupyterLeaseOptions) =>
        openRemoteJupyterLease({
          ...options,
          spawnImpl,
          allocateLocalPort: async () => ++localPort,
          waitUntilReady: async () => undefined,
          shutdownGraceMs: 80
        }),
      selectRemotePort: () => ++remotePort,
      shutdownGraceMs: 80,
      readyProbe: async () => {
        await waitForFile(input.pidFile)
        return true
      }
    })
}

async function prepareKernels(fixture: RemoteRuntimeFixture): Promise<{
  kernelspecs: RemoteKernelspecAdapter
  prefix: string
}> {
  fixture.workspace.micromambaPath = installFakeMicromamba(fixture, 'jupyter-e2e')
  const environments = new RemoteEnvironmentService({
    openWorkspace: async () => fixture.workspace,
    micromambaVersion: 'jupyter-e2e',
    confirm: async () => true,
    resolveBaseEnvironment: async () => ({ packages: [], channels: ['conda-forge'] })
  })
  const kernelspecs = new RemoteKernelspecAdapter({
    environments,
    openWorkspace: async () => fixture.workspace
  })
  await kernelspecs.prepare({ runtimeSessionId: RUNTIME_SESSION })
  const bound = await environments.bindSession({
    runtimeSessionId: RUNTIME_SESSION,
    ref: 'phi:jupyter@1'
  })
  assert.equal(typeof bound.prefix, 'string')
  return { kernelspecs, prefix: String(bound.prefix) }
}

async function installFakeJupyter(
  fixture: RemoteRuntimeFixture,
  prefix: string,
  savedEnvironment: Map<string, string | undefined>
): Promise<{ ssh: string; argsFile: string; pidFile: string }> {
  const env = {
    PHI_FAKE_JUPYTER_SSH_ARGS: join(fixture.root, 'ssh-args.log'),
    PHI_FAKE_JUPYTER_ARGS: join(fixture.root, 'jupyter-args.log'),
    PHI_FAKE_JUPYTER_PIDS: join(fixture.root, 'jupyter-pids')
  }
  for (const [key, value] of Object.entries(env)) {
    savedEnvironment.set(key, process.env[key])
    process.env[key] = value
  }
  const ssh = join(fixture.root, 'fake-ssh')
  await writeRemoteJupyterTestExecutables(ssh, join(prefix, 'bin', 'jupyter'))
  await installRemoteJupyterSetsid(fixture.root)
  process.env.PATH = `${fixture.root}:${process.env.PATH ?? ''}`
  return { ssh, argsFile: env.PHI_FAKE_JUPYTER_ARGS, pidFile: env.PHI_FAKE_JUPYTER_PIDS }
}

async function startBackend(
  fixture: RemoteRuntimeFixture,
  kernelspecs: RemoteKernelspecAdapter,
  ssh: string,
  pidFile: string,
  children: ChildProcessWithoutNullStreams[]
): Promise<RemoteJupyterRuntimeBackend> {
  const backend = new RemoteJupyterRuntimeBackend({
    kernelspecs,
    runtimeSessionId: RUNTIME_SESSION,
    createSupervisor: supervisorFactory({ root: fixture.root, ssh, pidFile, children })
  })
  await backend.start(fixture.projectRoot)
  return backend
}

function buildToolHarness(
  fixture: RemoteRuntimeFixture,
  backend: RemoteJupyterRuntimeBackend,
  events: string[]
): Map<string, NotebookCustomTool> {
  const sessions = new AnalysisNotebookSessionRegistry({
    runtimeBackend: backend,
    client: fakeSessionClient(events)
  })
  const workspace = createNotebookWorkspace({
    projectCwd: fixture.projectRoot,
    host: fixture.workspace.projectHost
  })
  const executor = new AnalysisNotebookToolExecutor({
    resolveWorkspaceByCwd: () => ({ workingDirectory: fixture.projectRoot }),
    resolveNotebookWorkspaceByCwd: () => workspace,
    resolveKernelsByCwd: () => backend.kernels(fixture.projectRoot)!,
    ensureJupyterServerReady: async () => {
      assert.equal(backend.status(fixture.projectRoot).state, 'ready')
    },
    notebookSessionRegistry: sessions,
    notebookExecutor: fakeNotebookExecutor(events)
  })
  return new Map(
    buildNotebookCustomTools((request) => executor.execute(request)).map((tool) => [
      tool.name,
      tool
    ])
  )
}

async function runSevenTools(
  tools: Map<string, NotebookCustomTool>,
  cwd: string
): Promise<{
  listed: Record<string, unknown>
  read: Record<string, unknown>
  ran: Record<string, unknown>
  saved: Record<string, unknown>
}> {
  const listed = await callNotebookTool(tools, 'notebook.list', cwd, {})
  const read = await callNotebookTool(tools, 'notebook.read', cwd, {
    path: 'notebooks/analysis.ipynb'
  })
  const inserted = await callNotebookTool(tools, 'notebook.insert_cell', cwd, {
    path: read.path,
    source: '# remote',
    cellType: 'markdown'
  })
  await callNotebookTool(tools, 'notebook.update_cell', cwd, {
    path: read.path,
    cellId: 'cell-1',
    source: 'x = 2'
  })
  await callNotebookTool(tools, 'notebook.delete_cell', cwd, {
    path: read.path,
    cellId: (inserted.cell as { id: string }).id
  })
  const ran = await callNotebookTool(tools, 'notebook.run_cell', cwd, {
    path: read.path,
    cellId: 'cell-1'
  })
  const saved = await callNotebookTool(tools, 'notebook.save', cwd, { path: read.path })
  return { listed, read, ran, saved }
}

async function assertE2eResult(input: {
  fixture: RemoteRuntimeFixture
  notebookDir: string
  argsFile: string
  events: string[]
  result: Awaited<ReturnType<typeof runSevenTools>>
}): Promise<void> {
  assert.equal((input.result.listed.notebooks as unknown[]).length, 1)
  assert.equal(input.result.read.path, join(input.notebookDir, 'analysis.ipynb'))
  assert.equal(input.result.ran.kind, 'notebook_cell_executed')
  assert.equal(input.result.saved.kind, 'notebook_saved')
  const disk = JSON.parse(await readFile(join(input.notebookDir, 'analysis.ipynb'), 'utf8')) as {
    cells: Array<{ source: string | string[]; execution_count: number; outputs: unknown[] }>
  }
  const source = disk.cells[0]?.source
  assert.equal(Array.isArray(source) ? source.join('') : source, 'x = 2')
  assert.equal(disk.cells[0]?.execution_count, 7)
  assert.equal(disk.cells[0]?.outputs.length, 1)
  assert.match(input.events.join('\n'), /session:.*phi-python[\s\S]*execute:cell-1:x = 2/)
  assert.equal(readFileSync(join(input.fixture.localAnchor, 'sentinel.txt'), 'utf8'), 'untouched')
  assert.deepEqual(readdirSync(input.fixture.localAnchor), ['sentinel.txt'])
  assert.match(
    readFileSync(join(input.fixture.runtimeRoot, 'micromamba-calls.log'), 'utf8'),
    /create/
  )
  assert.match(await readFile(input.argsFile, 'utf8'), /ServerApp\.ip=127\.0\.0\.1/)
}

async function cleanupFixture(input: {
  fixture: RemoteRuntimeFixture
  backend?: RemoteJupyterRuntimeBackend
  children: ChildProcessWithoutNullStreams[]
  savedPath?: string
  savedEnvironment: Map<string, string | undefined>
}): Promise<void> {
  await input.backend?.stop(input.fixture.projectRoot).catch(() => undefined)
  for (const child of input.children) child.kill('SIGKILL')
  process.env.PATH = input.savedPath
  for (const [key, value] of input.savedEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await input.fixture.workspace.projectHost.close?.().catch(() => undefined)
  await input.fixture.workspace.runtimeHost.close?.().catch(() => undefined)
  input.fixture.cleanup()
}

test('seven notebook tools stay on fake SSH workspace and remote Jupyter runtime', async () => {
  const fixture = createRemoteRuntimeFixture()
  const savedEnvironment = new Map<string, string | undefined>()
  const children: ChildProcessWithoutNullStreams[] = []
  const savedPath = process.env.PATH
  let backend: RemoteJupyterRuntimeBackend | undefined
  try {
    const notebookDir = join(fixture.projectRoot, 'notebooks')
    mkdirSync(notebookDir)
    writeFileSync(join(notebookDir, 'analysis.ipynb'), notebookBody())
    writeFileSync(join(fixture.localAnchor, 'sentinel.txt'), 'untouched')
    const prepared = await prepareKernels(fixture)
    const jupyter = await installFakeJupyter(fixture, prepared.prefix, savedEnvironment)
    backend = await startBackend(
      fixture,
      prepared.kernelspecs,
      jupyter.ssh,
      jupyter.pidFile,
      children
    )
    const events: string[] = []
    const result = await runSevenTools(
      buildToolHarness(fixture, backend, events),
      fixture.projectRoot
    )
    await assertE2eResult({ fixture, notebookDir, argsFile: jupyter.argsFile, events, result })
  } finally {
    await cleanupFixture({ fixture, backend, children, savedPath, savedEnvironment })
  }
})
