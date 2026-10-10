import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  reconcileRemoteJupyterLease,
  remoteJupyterLeaseIdentity,
  remoteJupyterReconcileActivity,
  type RemoteJupyterLeaseIdentity
} from '../src/main/agent/notebook/remote-jupyter-reconcile'
import type { RemoteJupyterLease } from '../src/main/agent/notebook/remote-jupyter-lease'
import { RemoteJupyterServerSupervisor } from '../src/main/agent/notebook/remote-jupyter-server'
import {
  installRemoteJupyterSetsid,
  writeRemoteJupyterTestExecutables
} from './helpers/remoteJupyterScripts'

const LEASE_ID = '0123456789abcdef0123456789abcdef'
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  assert.deepEqual(remoteJupyterReconcileActivity(), { children: 0, timers: 0 })
})

test('reconciliation accepts a missing lease record as already cleaned', async () => {
  const fixture = await createFixture()
  const result = await reconcileRemoteJupyterLease({
    connection: { host: 'fake-host' },
    identity: fixture.identity,
    spawnImpl: fixture.spawnImpl
  })

  assert.equal(result, 'already_cleaned')
  assert.equal(fixture.calls.length, 1)
  assert.ok(!fixture.calls[0].includes('-L'))
  assert.ok(fixture.calls[0].includes('ControlMaster=no'))
  assert.ok(fixture.calls[0].includes('ControlPath=none'))
})

test('reconciliation uses TERM then KILL for the matching recorded process group', async () => {
  const fixture = await createFixture()
  const child = await fixture.startRecordedProcess(true)

  const result = await reconcileRemoteJupyterLease({
    connection: { host: 'fake-host' },
    identity: fixture.identity,
    spawnImpl: fixture.spawnImpl,
    shutdownGraceMs: 30
  })
  const closed = await childClosed(child)

  assert.equal(result, 'terminated')
  assert.equal(closed.signal, 'SIGKILL')
  await assert.rejects(readFile(fixture.identity.recordPath), /ENOENT/)
})

test('reconciliation never signals a reused PID with a different start identity', async () => {
  const fixture = await createFixture()
  const child = await fixture.startRecordedProcess(false, 'stale process start identity')

  const result = await reconcileRemoteJupyterLease({
    connection: { host: 'fake-host' },
    identity: fixture.identity,
    spawnImpl: fixture.spawnImpl,
    shutdownGraceMs: 20
  })

  assert.equal(result, 'identity_mismatch')
  assert.equal(pidIsAlive(child.pid!), true)
  await assert.rejects(readFile(fixture.identity.recordPath), /ENOENT/)
})

test('reconciliation reports an unreachable fresh ssh connection without clearing ownership', async () => {
  const fixture = await createFixture()
  const failingSpawn: ReconcileFixture['spawnImpl'] = (_binary, _args, options) =>
    spawn('/bin/bash', ['-c', 'exit 255'], options)

  await assert.rejects(
    reconcileRemoteJupyterLease({
      connection: { host: 'fake-host' },
      identity: fixture.identity,
      spawnImpl: failingSpawn
    }),
    /清理确认连接不可用/
  )
  assert.deepEqual(remoteJupyterReconcileActivity(), { children: 0, timers: 0 })
})

test('reconciliation fails closed for a malformed lease ownership record', async () => {
  const fixture = await createFixture()
  await mkdir(dirname(fixture.identity.recordPath), { recursive: true })
  await writeFile(fixture.identity.recordPath, 'not-a-lease-record\n')

  await assert.rejects(
    reconcileRemoteJupyterLease({
      connection: { host: 'fake-host' },
      identity: fixture.identity,
      spawnImpl: fixture.spawnImpl
    }),
    /清理确认未完成/
  )
  assert.equal(await readFile(fixture.identity.recordPath, 'utf8'), 'not-a-lease-record\n')
})

test('supervisor terminates a matching surviving lease before starting a fresh runtime', async () => {
  const fixture = await createFixture()
  const firstClosed = deferredClose()
  let openCalls = 0
  let firstChild: ChildProcessWithoutNullStreams | undefined
  const supervisor = new RemoteJupyterServerSupervisor({
    connection: { host: 'fake-host' },
    launch: { command: '/fake/jupyter', env: { JUPYTER_RUNTIME_DIR: fixture.root } },
    spawnImpl: fixture.spawnImpl,
    selectRemotePort: sequencePorts(52_000),
    readyProbe: async () => true,
    shutdownGraceMs: 30,
    openLease: async (options) => {
      openCalls += 1
      if (openCalls > 1) return confirmedLease(41_000 + openCalls, options.remotePort)
      const identity = remoteJupyterLeaseIdentity(fixture.root, options.cleanupMarker)
      firstChild = await fixture.startRecordedProcess(true, undefined, identity)
      return unconfirmedLease(41_001, options.remotePort, firstClosed)
    }
  })
  cleanups.push(() => supervisor.stop({ abandonUnconfirmed: true }))

  const first = await supervisor.start()
  const firstToken = first.authorizationHeader()
  firstClosed.close()
  await waitFor(() => supervisor.status().state === 'error')
  const second = await supervisor.start()

  assert.equal(openCalls, 2)
  assert.notEqual(second.baseUrl, first.baseUrl)
  assert.notEqual(second.authorizationHeader(), firstToken)
  assert.ok(firstChild?.pid)
  await waitFor(() => !pidIsAlive(firstChild!.pid!))
})

interface ReconcileFixture {
  root: string
  identity: RemoteJupyterLeaseIdentity
  calls: string[][]
  spawnImpl: (
    binary: string,
    args: string[],
    options: { stdio: ['pipe', 'pipe', 'pipe'] }
  ) => ChildProcessWithoutNullStreams
  startRecordedProcess(
    ignoreTerm: boolean,
    recordedStart?: string,
    identity?: RemoteJupyterLeaseIdentity
  ): Promise<ChildProcessWithoutNullStreams>
}

async function createFixture(): Promise<ReconcileFixture> {
  const root = await mkdtemp(join(tmpdir(), 'phi-jupyter-reconcile-'))
  const savedPath = process.env.PATH
  cleanups.push(async () => rm(root, { recursive: true, force: true }))
  cleanups.push(() => {
    process.env.PATH = savedPath
  })
  const ssh = join(root, 'fake-ssh')
  await writeRemoteJupyterTestExecutables(ssh, join(root, 'fake-jupyter'))
  await installRemoteJupyterSetsid(root)
  process.env.PATH = `${root}:${savedPath ?? ''}`
  const identity = {
    leaseId: LEASE_ID,
    recordPath: join(root, 'runtime', 'phi-leases', `${LEASE_ID}.lease`)
  }
  const calls: string[][] = []
  const spawnImpl: ReconcileFixture['spawnImpl'] = (_binary, args, options) => {
    calls.push(args)
    return spawn(ssh, args, options)
  }
  return {
    root,
    identity,
    calls,
    spawnImpl,
    startRecordedProcess: (ignoreTerm, recordedStart, selectedIdentity = identity) =>
      startRecordedProcess(root, selectedIdentity, ignoreTerm, recordedStart)
  }
}

function deferredClose(): {
  promise: RemoteJupyterLease['closed']
  close(): void
  closed(): boolean
} {
  let ended = false
  let resolve!: (result: { code: number | null; signal: string | null }) => void
  const promise = new Promise<{ code: number | null; signal: string | null }>((accept) => {
    resolve = accept
  })
  return {
    promise,
    close: () => {
      ended = true
      resolve({ code: 255, signal: null })
    },
    closed: () => ended
  }
}

function unconfirmedLease(
  localPort: number,
  remotePort: number,
  closed: ReturnType<typeof deferredClose>
): RemoteJupyterLease {
  return {
    localPort,
    remotePort,
    closed: closed.promise,
    isClosed: closed.closed,
    started: () => true,
    cleanupConfirmed: () => false,
    localSpawnFailed: () => false,
    forwardFailureConfirmed: () => false,
    close: async () => undefined
  }
}

function confirmedLease(localPort: number, remotePort: number): RemoteJupyterLease {
  const closed = deferredClose()
  return {
    ...unconfirmedLease(localPort, remotePort, closed),
    cleanupConfirmed: () => closed.closed(),
    close: async () => closed.close()
  }
}

function sequencePorts(start: number): () => number {
  let port = start
  return () => ++port
}

async function startRecordedProcess(
  root: string,
  identity: RemoteJupyterLeaseIdentity,
  ignoreTerm: boolean,
  recordedStart?: string
): Promise<ChildProcessWithoutNullStreams> {
  const sleeper = join(root, `sleeper-${ignoreTerm ? 'stubborn' : 'normal'}`)
  await writeFile(
    sleeper,
    `#!/bin/bash\ntrap '${ignoreTerm ? '' : 'exit 0'}' TERM INT\nwhile :; do sleep 0.05; done\n`,
    { mode: 0o755 }
  )
  const child = spawn(join(root, 'setsid'), [sleeper], {
    env: { ...process.env, PHI_JUPYTER_LEASE_ID: identity.leaseId },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  if (!child.pid) throw new Error('recorded process did not start')
  cleanups.push(() => killProcessGroup(child))
  await waitFor(() => pidIsAlive(child.pid!))
  const start = recordedStart ?? fakeProcessStart(child.pid)
  await mkdir(dirname(identity.recordPath), { recursive: true })
  await writeFile(
    identity.recordPath,
    `PHI_JUPYTER_LEASE_V1\n${identity.leaseId}\n${child.pid}\n${child.pid}\n${start}\n`
  )
  return child
}

function fakeProcessStart(pid: number): string {
  return `Thu Jan  1 00:00:${String(pid % 60).padStart(2, '0')} 1970`
}

async function killProcessGroup(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || !pidIsAlive(child.pid)) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  await childClosed(child)
}

function childClosed(
  child: ChildProcessWithoutNullStreams
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
