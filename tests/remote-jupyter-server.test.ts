import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  RemoteJupyterServerSupervisor,
  buildRemoteJupyterLaunchScript,
  buildRemoteJupyterSshArgs,
  type RemoteJupyterServerStatus
} from '../src/main/agent/notebook/remote-jupyter-server'
import {
  openRemoteJupyterLease,
  remoteJupyterLeaseActivity,
  type OpenRemoteJupyterLeaseOptions,
  type RemoteJupyterLease
} from '../src/main/agent/notebook/remote-jupyter-lease'
import {
  installBlockingRemoteJupyterSetsid,
  installRemoteJupyterSetsid,
  writeRemoteJupyterTestExecutables
} from './helpers/remoteJupyterScripts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PHI_FAKE_JUPYTER_') || key.startsWith('PHI_SETSID_')) {
      delete process.env[key]
    }
  }
})

test('remote launch and ssh argv bind loopback without embedding a token', () => {
  const cleanupMarker = '__PHI_JUPYTER_CLEANED_0123456789abcdef0123456789abcdef__'
  const script = buildRemoteJupyterLaunchScript(
    {
      command: '/opt/phi/bin/jupyter',
      args: ['server'],
      env: {
        JUPYTER_PATH: '/srv/phi/runtime/jupyter',
        JUPYTER_RUNTIME_DIR: '/srv/phi/runtime/jupyter/runtime'
      }
    },
    54123,
    cleanupMarker,
    25
  )
  const args = buildRemoteJupyterSshArgs({ host: 'lab', port: 2222 }, 43123, 54123, script)

  assert.match(script, /ServerApp\.ip=127\.0\.0\.1/)
  assert.match(script, /ServerApp\.port=54123/)
  assert.match(script, /ServerApp\.port_retries=0/)
  assert.match(script, /ServerApp\.write_server_info_file=False/)
  assert.match(script, /ServerApp\.write_browser_open_file=False/)
  assert.match(script, /ServerApp\.allow_remote_access=False/)
  assert.match(script, /JUPYTER_PATH='\/srv\/phi\/runtime\/jupyter'/)
  assert.match(script, /JUPYTER_RUNTIME_DIR='\/srv\/phi\/runtime\/jupyter\/runtime'/)
  assert.match(script, /trap 'terminate_tree; exit 73' HUP TERM INT/)
  assert.match(script, /trap 'terminate_tree' EXIT/)
  assert.match(script, /kill -TERM -"\$pid".*kill -TERM "\$pid".*kill -TERM -"\$pid"/s)
  assert.match(script, /kill -KILL -"\$pid".*kill -KILL "\$pid".*kill -KILL -"\$pid"/s)
  assert.ok(args.includes('ClearAllForwardings=no'))
  assert.ok(args.includes('ExitOnForwardFailure=yes'))
  assert.ok(args.includes('-L'))
  assert.ok(!args.includes('-N'))
  assert.ok(!args.includes('ClearAllForwardings=yes'))
  assert.equal(args.at(-1), script)
  assert.doesNotMatch(args.join('\n'), /--ServerApp\.token=/)
})

test('remote launch rejects untrusted environment keys and token material', () => {
  const cleanupMarker = '__PHI_JUPYTER_CLEANED_0123456789abcdef0123456789abcdef__'
  assert.throws(
    () =>
      buildRemoteJupyterLaunchScript(
        { command: '/opt/phi/bin/jupyter', env: { JUPYTER_TOKEN: 'must-not-be-accepted' } },
        54123,
        cleanupMarker
      ),
    /环境变量无效/u
  )
})

test('token stays off argv, files, status, and logs; stop reaps the process group', async () => {
  const fixture = await createFixture()
  const logs: string[] = []
  const states: string[] = []
  let authorization = ''
  const supervisor = fixture.supervisor({
    onLog: (line) => logs.push(line),
    onStateChange: (status) => states.push(status.state),
    readyProbe: async (_url, header) => {
      authorization = header
      await waitForFile(fixture.pidPath)
      return true
    }
  })

  const connection = await supervisor.start()
  const token = authorization.replace(/^token /, '')
  assert.equal(Buffer.from(token, 'base64url').byteLength, 32)
  const endpoint = new URL(connection.baseUrl)
  assert.equal(endpoint.hostname, '127.0.0.1')
  assert.ok(Number(endpoint.port) >= 41001)
  assert.equal(connection.authorizationHeader(), authorization)
  await waitFor(() => logs.some((line) => line.includes('<redacted>')))

  assert.doesNotMatch(await readFile(fixture.sshArgsPath, 'utf8'), new RegExp(token))
  assert.doesNotMatch(await readFile(fixture.jupyterArgsPath, 'utf8'), new RegExp(token))
  assert.doesNotMatch(JSON.stringify(supervisor.status()), new RegExp(token))
  assert.ok(logs.every((line) => !line.includes(token)))
  assert.ok(logs.includes('split=<redacted>'))
  for (const file of await readdir(fixture.root)) {
    if (file === 'fake-jupyter' || file === 'fake-ssh') continue
    assert.doesNotMatch(await readFile(join(fixture.root, file), 'utf8'), new RegExp(token))
  }

  const pids = await readPids(fixture.pidPath)
  await supervisor.stop()
  await waitFor(async () => (await Promise.all(pids.map(pidIsAlive))).every((alive) => !alive))
  assertReadyAndStoppedStates(states)
  await waitFor(() => {
    const activity = remoteJupyterLeaseActivity()
    return activity.children === 0 && activity.timers === 0
  })
})

test('remote port conflicts retry only to the configured limit with fresh ports and tokens', async () => {
  const fixture = await createFixture()
  process.env.PHI_FAKE_JUPYTER_ALWAYS_FAIL = '1'
  const headers: string[] = []
  const conflictLogs: string[] = []
  let failureText = ''
  const supervisor = fixture.supervisor({
    onLog: (line) => conflictLogs.push(line),
    maxStartAttempts: 2,
    startupTimeoutMs: 600,
    probeIntervalMs: 10,
    readyProbe: async (_url, header) => {
      headers.push(header)
      if (new Set(headers).size === 2) throw new Error(`probe failed: ${header}`)
      await waitFor(async () => (await launchCount(fixture.jupyterArgsPath)) >= 1, 20_000)
      return false
    }
  })

  await assert.rejects(supervisor.start(), (error) => {
    if (!(error instanceof Error)) return false
    failureText = `${error.message}\n${String(error.cause)}`
    return /2 次尝试/.test(error.message)
  })
  assert.ok(
    conflictLogs.some((line) => line.includes('__PHI_JUPYTER_CLEANED_')),
    JSON.stringify(conflictLogs)
  )
  const launches = (await readFile(fixture.jupyterArgsPath, 'utf8'))
    .split('\n---\n')
    .filter(Boolean)
  assert.ok(launches.length >= 1)
  const leaseCalls = fixture.sshCalls.filter((args) => !args.includes('-N'))
  assert.equal(leaseCalls.length, 2)
  assert.notEqual(
    portFromArgs(leaseCalls[0].at(-1) ?? ''),
    portFromArgs(leaseCalls[1].at(-1) ?? '')
  )
  assert.equal(new Set(headers).size, 2)
  for (const header of headers) assert.ok(!failureText.includes(header.replace(/^token /, '')))
  assert.equal(supervisor.status().state, 'error')
  await supervisor.stop()
})

test('losing the tunnel marks disconnected and unconditionally reaps remote jupyter', async () => {
  const fixture = await createFixture()
  const states: string[] = []
  let restartDuringCleanup: Promise<unknown> | undefined
  const supervisor = fixture.supervisor({
    onStateChange: (status) => {
      states.push(status.state)
      if (status.state === 'disconnected') {
        restartDuringCleanup = supervisor.start()
        void restartDuringCleanup.catch(() => undefined)
        throw new Error('observer failure must not stop cleanup')
      }
    },
    readyProbe: async () => {
      await waitForFile(fixture.pidPath)
      return true
    }
  })
  await supervisor.start()
  const pids = await readPids(fixture.pidPath)
  fixture.leaseChildren.at(-1)?.kill('SIGHUP')

  await waitFor(() => supervisor.status().state === 'stopped')
  await assert.rejects(restartDuringCleanup!, /正在清理/)
  await waitFor(async () => (await Promise.all(pids.map(pidIsAlive))).every((alive) => !alive))
  assert.ok(states.includes('disconnected'))
  assert.ok(states.includes('cleaning'))
})

test('an unconfirmed hard disconnect blocks a second remote runtime', async () => {
  let ended = false
  let resolveClosed!: (result: { code: number | null; signal: string | null }) => void
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })
  const lease: RemoteJupyterLease = {
    localPort: 41009,
    remotePort: 52009,
    closed,
    isClosed: () => ended,
    started: () => true,
    cleanupConfirmed: () => false,
    localSpawnFailed: () => false,
    forwardFailureConfirmed: () => false,
    close: async () => undefined
  }
  const supervisor = new RemoteJupyterServerSupervisor({
    connection: { host: 'fake-host' },
    launch: { command: '/fake/jupyter' },
    openLease: async () => lease,
    selectRemotePort: () => lease.remotePort,
    readyProbe: async () => true
  })

  await supervisor.start()
  ended = true
  resolveClosed({ code: 255, signal: null })
  await waitFor(() => supervisor.status().state === 'error')
  await assert.rejects(supervisor.start(), /清理尚未确认/)
  await supervisor.stop()
  assert.equal(supervisor.status().state, 'error')
})

test('cancellation before setsid completes kills the verified launcher pid', async () => {
  const fixture = await createFixture()
  const gate = join(fixture.root, 'setsid.gate')
  const setsidPid = join(fixture.root, 'setsid.pid')
  await installBlockingRemoteJupyterSetsid(fixture.root)
  process.env.PHI_SETSID_GATE = gate
  process.env.PHI_SETSID_PID = setsidPid
  const supervisor = fixture.supervisor({
    readyProbe: async () => {
      await waitForFile(setsidPid)
      return true
    }
  })

  await supervisor.start()
  const pid = Number((await readFile(setsidPid, 'utf8')).trim())
  assert.equal(await pidIsAlive(pid), true)
  await supervisor.stop()
  await waitFor(async () => !(await pidIsAlive(pid)))
  assert.equal(await fileExists(gate), false)
})

interface SupervisorOverrides {
  readyProbe?: (url: string, authorization: string, signal?: AbortSignal) => Promise<boolean>
  onLog?: (line: string) => void
  onStateChange?: (status: RemoteJupyterServerStatus) => void
  maxStartAttempts?: number
  startupTimeoutMs?: number
  probeIntervalMs?: number
}

function assertReadyAndStoppedStates(states: string[]): void {
  assert.deepEqual(states.slice(0, 3), [
    'preparing_environment',
    'allocating_ports',
    'starting_lease'
  ])
  assert.ok(states.indexOf('ready') > states.indexOf('probing_through_tunnel'))
  assert.ok(states.includes('stopping'))
  assert.ok(states.includes('cleaning'))
}

interface RemoteJupyterFixture {
  root: string
  sshArgsPath: string
  jupyterArgsPath: string
  pidPath: string
  leaseChildren: ChildProcessWithoutNullStreams[]
  sshCalls: string[][]
  supervisor(overrides: SupervisorOverrides): RemoteJupyterServerSupervisor
}

async function createFixture(): Promise<RemoteJupyterFixture> {
  const root = await mkdtemp(join(tmpdir(), 'phi-remote-jupyter-'))
  const savedPath = process.env.PATH
  cleanups.push(async () => rm(root, { recursive: true, force: true }))
  cleanups.push(() => {
    process.env.PATH = savedPath
  })
  const sshArgsPath = join(root, 'ssh-args.log')
  const jupyterArgsPath = join(root, 'jupyter-args.log')
  const pidPath = join(root, 'jupyter-pids')
  configureFixtureEnvironment(sshArgsPath, jupyterArgsPath, pidPath)
  const ssh = join(root, 'fake-ssh')
  const jupyter = join(root, 'fake-jupyter')
  await writeRemoteJupyterTestExecutables(ssh, jupyter)
  await installRemoteJupyterSetsid(root)
  process.env.PATH = `${root}:${savedPath ?? ''}`
  const leaseChildren: ChildProcessWithoutNullStreams[] = []
  const sshCalls: string[][] = []
  const spawnImpl = fakeSpawn(ssh, leaseChildren, sshCalls)
  let localPort = 41000
  const openLease = (options: OpenRemoteJupyterLeaseOptions): Promise<RemoteJupyterLease> =>
    openRemoteJupyterLease({
      ...options,
      spawnImpl,
      allocateLocalPort: async () => ++localPort,
      waitUntilReady: async () => undefined,
      shutdownGraceMs: 80
    })
  return {
    root,
    sshArgsPath,
    jupyterArgsPath,
    pidPath,
    leaseChildren,
    sshCalls,
    supervisor: (overrides: SupervisorOverrides) =>
      trackedSupervisor({
        connection: { host: 'fake-host' },
        launch: { command: jupyter, args: ['server'] },
        spawnImpl,
        openLease,
        selectRemotePort: sequencePorts(52000),
        shutdownGraceMs: 80,
        ...overrides
      })
  }
}

function trackedSupervisor(
  options: ConstructorParameters<typeof RemoteJupyterServerSupervisor>[0]
): RemoteJupyterServerSupervisor {
  const supervisor = new RemoteJupyterServerSupervisor(options)
  cleanups.push(() => supervisor.stop())
  return supervisor
}

function fakeSpawn(binary: string, leases: ChildProcessWithoutNullStreams[], calls: string[][]) {
  return (
    _ssh: string,
    args: string[],
    options: { stdio: ['pipe', 'pipe', 'pipe'] }
  ): ChildProcessWithoutNullStreams => {
    calls.push(args)
    const child = spawn(binary, args, options)
    if (args.includes('-L')) leases.push(child)
    return child
  }
}

function configureFixtureEnvironment(
  sshArgsPath: string,
  jupyterArgsPath: string,
  pidPath: string
): void {
  process.env.PHI_FAKE_JUPYTER_SSH_ARGS = sshArgsPath
  process.env.PHI_FAKE_JUPYTER_ARGS = jupyterArgsPath
  process.env.PHI_FAKE_JUPYTER_PIDS = pidPath
}

function sequencePorts(start: number): () => number {
  let port = start
  return () => ++port
}

function portFromArgs(args: string): string | undefined {
  return /--ServerApp\.port=([0-9]+)/.exec(args)?.[1]
}

async function launchCount(path: string): Promise<number> {
  const content = await readFile(path, 'utf8').catch(() => '')
  return content.split('\n---\n').filter(Boolean).length
}

async function readPids(path: string): Promise<number[]> {
  return (await readFile(path, 'utf8')).trim().split(/\s+/).map(Number)
}

async function pidIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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
  await waitFor(() => fileExists(path))
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false
  )
}
