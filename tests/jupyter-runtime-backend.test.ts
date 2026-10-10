import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import type { AnalysisKernelDiagnostics } from '../src/main/agent/notebook/analysis-kernels'
import {
  RemoteJupyterRuntimeBackend,
  type RemoteJupyterRuntimeBackendOptions
} from '../src/main/agent/notebook/jupyter-runtime-backend'
import { AnalysisNotebookSessionRegistry } from '../src/main/agent/notebook/analysis-jupyter-sessions'
import {
  RemoteJupyterServerSupervisor,
  type RemoteJupyterLaunchCommand
} from '../src/main/agent/notebook/remote-jupyter-server'
import {
  openRemoteJupyterLease,
  type OpenRemoteJupyterLeaseOptions
} from '../src/main/agent/notebook/remote-jupyter-lease'
import type { SshPortForwardSpawn } from '../src/main/agent/workspace-host/ssh-port-forward'
import { parseNotebook } from '../src/shared/notebookDocument'
import {
  installRemoteJupyterSetsid,
  writeRemoteJupyterTestExecutables
} from './helpers/remoteJupyterScripts'

const PROJECT = '/remote/project'

interface RuntimeFixture {
  root: string
  jupyter: string
  events: string[]
  leaseChildren: ChildProcessWithoutNullStreams[]
  sshCalls: string[][]
  readyCalls: Array<{ url: string; authorization: string }>
  supervisor(launch: RemoteJupyterLaunchCommand): RemoteJupyterServerSupervisor
  cleanup(): Promise<void>
}

interface BackendHarness {
  backend: RemoteJupyterRuntimeBackend
  prepareCalls(): number
}

async function createFixture(): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'phi-runtime-backend-'))
  const savedPath = process.env.PATH
  const savedEnvironment = new Map<string, string | undefined>()
  const env = {
    PHI_FAKE_JUPYTER_SSH_ARGS: join(root, 'ssh-args.log'),
    PHI_FAKE_JUPYTER_ARGS: join(root, 'jupyter-args.log'),
    PHI_FAKE_JUPYTER_PIDS: join(root, 'jupyter-pids')
  }
  for (const [key, value] of Object.entries(env)) {
    savedEnvironment.set(key, process.env[key])
    process.env[key] = value
  }
  const ssh = join(root, 'fake-ssh')
  const jupyter = join(root, 'fake-jupyter')
  await writeRemoteJupyterTestExecutables(ssh, jupyter)
  await installRemoteJupyterSetsid(root)
  process.env.PATH = `${root}:${savedPath ?? ''}`

  const events: string[] = []
  const leaseChildren: ChildProcessWithoutNullStreams[] = []
  const sshCalls: string[][] = []
  const readyCalls: Array<{ url: string; authorization: string }> = []
  const spawnImpl: SshPortForwardSpawn = (_binary, args, options) => {
    events.push('lease')
    sshCalls.push(args)
    const child = spawn(ssh, args, options)
    if (args.includes('-L')) leaseChildren.push(child)
    return child
  }
  let localPort = 41000
  let remotePort = 52000

  return {
    root,
    jupyter,
    events,
    leaseChildren,
    sshCalls,
    readyCalls,
    supervisor: (launch) =>
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
        readyProbe: async (url, authorization) => {
          readyCalls.push({ url, authorization })
          await waitForFile(env.PHI_FAKE_JUPYTER_PIDS)
          return true
        }
      }),
    cleanup: async () => {
      process.env.PATH = savedPath
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  }
}

function createBackend(fixture: RuntimeFixture): BackendHarness {
  let count = 0
  const kernelspecs: RemoteJupyterRuntimeBackendOptions['kernelspecs'] = {
    prepareRuntime: async ({ signal }) => {
      signal?.throwIfAborted()
      count += 1
      fixture.events.push('prepare')
      return {
        kernels: diagnostics(),
        launch: { command: fixture.jupyter, args: ['server'], cwd: fixture.root }
      }
    },
    select: (available, name) => {
      const selected = available.kernels.find((kernel) => kernel.name === (name ?? 'phi-python'))
      if (!selected) throw new Error('kernel missing')
      return selected
    }
  }
  return {
    backend: new RemoteJupyterRuntimeBackend({
      kernelspecs,
      runtimeSessionId: 'runtime-session-1',
      createSupervisor: (launch) => fixture.supervisor(launch)
    }),
    prepareCalls: () => count
  }
}

function diagnostics(): AnalysisKernelDiagnostics {
  return {
    jupyterServer: { available: true, command: 'jupyter', version: '2.21.1' },
    kernels: [
      {
        name: 'phi-python',
        displayName: 'Python 3.12 (phi-python)',
        language: 'python',
        rawLanguage: 'python',
        status: 'ready'
      }
    ],
    preferredKernelName: 'phi-python',
    hasPythonKernel: true,
    hasRKernel: false,
    messages: []
  }
}

async function dispose(harness: BackendHarness, fixture: RuntimeFixture): Promise<void> {
  await harness.backend.stop(PROJECT).catch(() => undefined)
  await fixture.cleanup()
}

test('remote backend prepares the adapter before probing only the authenticated local tunnel', async () => {
  const fixture = await createFixture()
  const harness = createBackend(fixture)
  try {
    await harness.backend.start(PROJECT)

    assert.ok(fixture.events.indexOf('prepare') < fixture.events.indexOf('lease'))
    assert.equal(harness.prepareCalls(), 1)
    assert.equal(fixture.readyCalls.length, 1)
    const ready = fixture.readyCalls[0]
    const readyUrl = new URL(ready.url)
    const status = harness.backend.status(PROJECT)
    assert.equal(readyUrl.hostname, '127.0.0.1')
    assert.equal(Number(readyUrl.port), status.localPort)
    assert.notEqual(Number(readyUrl.port), status.remotePort)
    assert.match(ready.authorization, /^token [A-Za-z0-9_-]{43}$/)
    assert.equal(harness.backend.connection(PROJECT)?.url, ready.url)
    assert.doesNotMatch(JSON.stringify(status), /token /)
  } finally {
    await dispose(harness, fixture)
  }
})

test('remote backend coalesces concurrent starts and keeps a ready start idempotent', async () => {
  const fixture = await createFixture()
  const harness = createBackend(fixture)
  try {
    await Promise.all([harness.backend.start(PROJECT), harness.backend.start(PROJECT)])
    await harness.backend.start(PROJECT)

    assert.equal(harness.prepareCalls(), 1)
    assert.equal(fixture.sshCalls.filter((args) => args.includes('-L')).length, 1)
    assert.equal(fixture.readyCalls.length, 1)
  } finally {
    await dispose(harness, fixture)
  }
})

test('remote backend restarts after disconnect with a new runtime id, token, and local port', async () => {
  const fixture = await createFixture()
  const harness = createBackend(fixture)
  try {
    await harness.backend.start(PROJECT)
    const first = harness.backend.connection(PROJECT)
    assert.ok(first)
    const firstRuntimeId = first.runtimeId
    const firstUrl = first.url
    const firstAuthorization = first.authorizationHeader?.()

    fixture.leaseChildren.at(-1)?.kill('SIGHUP')
    await waitFor(() => harness.backend.status(PROJECT).state === 'stopped')
    assert.equal(harness.backend.connection(PROJECT), null)

    await harness.backend.start(PROJECT)
    const second = harness.backend.connection(PROJECT)
    assert.ok(second)
    assert.notEqual(second.runtimeId, firstRuntimeId)
    assert.notEqual(second.url, firstUrl)
    assert.notEqual(second.authorizationHeader?.(), firstAuthorization)
    assert.equal(harness.prepareCalls(), 2)
  } finally {
    await dispose(harness, fixture)
  }
})

test('closing the last notebook session does not stop a ready remote backend', async () => {
  const fixture = await createFixture()
  const harness = createBackend(fixture)
  const deleted: string[] = []
  try {
    await harness.backend.start(PROJECT)
    const runtimeId = harness.backend.connection(PROJECT)?.runtimeId
    const sessions = new AnalysisNotebookSessionRegistry({
      runtimeBackend: harness.backend,
      client: {
        createSession: async () => ({
          id: 'session-1',
          kernelId: 'kernel-1',
          kernelName: 'phi-python',
          executionState: 'idle'
        }),
        deleteSession: async (_connection, sessionId) => {
          deleted.push(sessionId)
        },
        interruptKernel: async () => undefined
      }
    })
    const notebookPath = `${PROJECT}/demo.ipynb`
    await sessions.ensureSession({
      projectCwd: PROJECT,
      notebookPath,
      document: parseNotebook({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: {
            display_name: 'Python 3.12 (phi-python)',
            language: 'python',
            name: 'phi-python'
          }
        },
        cells: []
      }),
      kernels: diagnostics()
    })

    await sessions.closeSession(PROJECT, notebookPath)

    assert.deepEqual(deleted, ['session-1'])
    assert.equal(sessions.projectSummary(PROJECT).activeSessionCount, 0)
    assert.equal(harness.backend.status(PROJECT).state, 'ready')
    assert.equal(harness.backend.connection(PROJECT)?.runtimeId, runtimeId)
  } finally {
    await dispose(harness, fixture)
  }
})

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForFile(path: string): Promise<void> {
  await waitFor(() =>
    readFile(path).then(
      () => true,
      () => false
    )
  )
}
