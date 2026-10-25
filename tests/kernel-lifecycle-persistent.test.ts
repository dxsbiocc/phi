import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  KernelProtocolClient,
  spawnKernelStdio,
  type KernelClientTransport,
  type SpawnedKernelClient
} from '../src/main/agent/engine/kernel-client'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import type { JsonValue } from '../src/shared/kernel-protocol'
import { createInProcessFixture } from './engine-contract/in-process-factory'

const TOKEN = '7b'.repeat(32)

type SocketKernelFixture = {
  base: Awaited<ReturnType<typeof createInProcessFixture>>
  child: ChildProcessWithoutNullStreams
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  initialClient: KernelProtocolClient
  kernelInstanceId: string
  socketPath: string
  tokenFilePath: string
  runtimeDirectory: string
  connect(takeover?: boolean): Promise<KernelProtocolClient>
  spawnPeer(): Promise<SpawnedKernelClient>
  close(): Promise<void>
}

type RunReceipt = {
  runId: string
  state: 'accepted' | 'terminal'
  status?: 'completed' | 'failed' | 'cancelled' | 'unknown'
  at?: string
}

class SocketClientTransport implements KernelClientTransport {
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private buffer = ''
  private closed = false

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      while (true) {
        const delimiter = this.buffer.indexOf('\n')
        if (delimiter === -1) return
        const line = this.buffer.slice(0, delimiter)
        this.buffer = this.buffer.slice(delimiter + 1)
        if (line) for (const listener of this.lineListeners) listener(line)
      }
    })
    socket.once('close', () => this.notifyClosed())
    socket.once('error', () => this.notifyClosed())
  }

  send(line: string): void {
    if (this.closed) throw new Error('Kernel socket transport is closed')
    this.socket.write(line)
  }

  onLine(callback: (line: string) => void): void {
    this.lineListeners.add(callback)
  }

  onClose(callback: () => void): void {
    if (this.closed) queueMicrotask(callback)
    else this.closeListeners.add(callback)
  }

  async close(): Promise<void> {
    if (this.closed) return
    const closed = once(this.socket, 'close')
    this.socket.destroy()
    await closed
  }

  private notifyClosed(): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }
}

function record(value: JsonValue): Record<string, JsonValue> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, JsonValue>
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

async function within<T>(promise: Promise<T>, description: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection(socketPath)
    const onError = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.off('error', onError)
      resolveConnection(socket)
    })
  })
}

async function startSocketKernel(
  t: TestContext,
  graceMs: number
): Promise<SocketKernelFixture | undefined> {
  let base: Awaited<ReturnType<typeof createInProcessFixture>>
  try {
    base = await createInProcessFixture()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM' || String(error).includes('EPERM')) {
      t.skip('sandbox forbids listening on 127.0.0.1')
      return undefined
    }
    throw error
  }

  const root = dirname(base.agentDir)
  const runtimeDirectory = mkdtempSync(join(tmpdir(), 'phi-k-persist-'))
  chmodSync(runtimeDirectory, 0o700)
  const socketPath = join(runtimeDirectory, 'kernel.sock')
  const tokenFilePath = join(runtimeDirectory, 'kernel.token')
  writeFileSync(tokenFilePath, `${TOKEN}\n`, { mode: 0o600 })
  let diagnostics = ''
  let kernelInstanceId = ''
  const kernelEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    XDG_CACHE_HOME: join(root, 'home', '.cache'),
    XDG_DATA_HOME: join(root, 'home', '.local/share'),
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    PI_CODING_AGENT_DIR: base.agentDir,
    OMP_APP_NAME: 'Phi',
    NO_PROXY: '127.0.0.1,localhost'
  }
  const child = spawn(
    resolveBunExecutable(),
    [
      '--preload',
      fileURLToPath(new URL('./engine-contract/network-guard.ts', import.meta.url)),
      resolve('src/kernel/main.ts'),
      '--listen',
      socketPath,
      '--token-file',
      tokenFilePath,
      '--grace-ms',
      String(graceMs)
    ],
    {
      cwd: resolve('.'),
      env: kernelEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    diagnostics += chunk
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => child.once('close', (code, signal) => resolveExit({ code, signal }))
  )

  const connect = async (takeover = false): Promise<KernelProtocolClient> => {
    const deadline = Date.now() + 10_000
    let socket: Socket | undefined
    while (!socket) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Socket kernel exited before attach.\n${diagnostics}`)
      }
      try {
        socket = await connectSocket(socketPath)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['ENOENT', 'ECONNREFUSED'].includes(code ?? '') || Date.now() > deadline) throw error
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      }
    }
    socket.write(`${JSON.stringify({ phiKernelAttach: 1, token: TOKEN })}\n`)
    const client = new KernelProtocolClient(new SocketClientTransport(socket))
    const greeting = await client.hello({ takeover })
    kernelInstanceId ||= greeting.kernelInstanceId
    assert.equal(greeting.kernelInstanceId, kernelInstanceId)
    await client.subscribe(0)
    return client
  }

  const spawnPeer = async (): Promise<SpawnedKernelClient> => {
    const peer = spawnKernelStdio({
      cwd: resolve('.'),
      bunArgs: [
        '--preload',
        fileURLToPath(new URL('./engine-contract/network-guard.ts', import.meta.url))
      ],
      env: kernelEnv,
      onDiagnostic: (text) => {
        diagnostics += text
      }
    })
    try {
      await peer.client.hello()
      await peer.client.subscribe(0)
      return peer
    } catch (error) {
      await peer.close()
      throw error
    }
  }

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
      await base.close()
      rmSync(runtimeDirectory, { recursive: true, force: true })
    })()
    return closing
  }

  const fixtureWithoutClient = {
    base,
    child,
    exited,
    socketPath,
    tokenFilePath,
    runtimeDirectory,
    connect,
    spawnPeer,
    close
  }
  try {
    const initialClient = await connect()
    return { ...fixtureWithoutClient, initialClient, kernelInstanceId }
  } catch (error) {
    if (String(error).includes('EPERM') || diagnostics.includes('EPERM')) {
      await close()
      t.skip('sandbox forbids Unix-domain listen(2)')
      return undefined
    }
    await close()
    throw error
  }
}

async function createPersistentSession(
  fixture: SocketKernelFixture,
  client: KernelProtocolClient
): Promise<string> {
  const created = record(
    await client.request('session.create', {
      cwd: fixture.base.cwd,
      model: { provider: fixture.base.model.provider, id: fixture.base.model.id },
      sessionManager: { kind: 'persistent' },
      resourceOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true
      },
      noTools: 'all',
      enableToolApproval: false,
      autoCompaction: { enabled: false }
    })
  )
  assert.equal(typeof created.sessionId, 'string')
  const sessionId = String(created.sessionId)
  const writerLock = JSON.parse(
    readFileSync(sessionPath(fixture, sessionId, 'writer.lock'), 'utf8')
  ) as { kernelInstanceId?: unknown }
  assert.equal(
    writerLock.kernelInstanceId,
    fixture.kernelInstanceId,
    'socket hello and writer lock must expose one kernel instance identity'
  )
  return sessionId
}

function sessionPath(fixture: SocketKernelFixture, sessionId: string, file: string): string {
  return join(fixture.base.agentDir, 'phi-kernel', 'sessions', sessionId, file)
}

function receipts(fixture: SocketKernelFixture, sessionId: string): RunReceipt[] {
  return readFileSync(sessionPath(fixture, sessionId, 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunReceipt)
}

test(
  'a persistent run completes during socket grace and is visible after reconnect',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await startSocketKernel(t, 5_000)
    if (!fixture) return
    let client: KernelProtocolClient | undefined
    try {
      client = fixture.initialClient
      const sessionId = await createPersistentSession(fixture, client)
      const releaseFinal = deferred()
      const requestCount = fixture.base.provider.requests.length
      fixture.base.provider.enqueue({
        text: 'completed while the controller was disconnected',
        waitFor: releaseFinal.promise
      })
      const accepted = record(
        await client.request(
          'session.prompt',
          { text: 'finish during grace', clientRunKey: 'socket-grace-complete' },
          { sessionId }
        )
      )
      assert.equal(typeof accepted.runId, 'string')
      await waitFor(
        () => fixture.base.provider.requests.length >= requestCount + 1,
        'held provider request'
      )

      await client.close()
      client = undefined
      releaseFinal.resolve()
      await waitFor(
        () =>
          receipts(fixture, sessionId).some(
            (receipt) =>
              receipt.state === 'terminal' &&
              receipt.runId === accepted.runId &&
              receipt.status === 'completed'
          ),
        'terminal receipt written during grace'
      )

      client = await fixture.connect(true)
      const snapshot = record(await client.request('session.snapshot', {}, { sessionId }))
      assert.deepEqual(snapshot.lastRun, { runId: accepted.runId, status: 'completed' })
      assert.ok(
        JSON.stringify(snapshot.messages).includes(
          'completed while the controller was disconnected'
        )
      )
    } finally {
      await client?.close()
      await fixture.close()
    }
  }
)

test(
  'socket grace expiry persists a terminal cancelled receipt before kernel exit',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await startSocketKernel(t, 1_000)
    if (!fixture) return
    let client: KernelProtocolClient | undefined
    let peer: SpawnedKernelClient | undefined
    try {
      client = fixture.initialClient
      const sessionId = await createPersistentSession(fixture, client)
      const requestCount = fixture.base.provider.requests.length
      fixture.base.provider.enqueue({ text: 'held until grace expiry', hold: true })
      const accepted = record(
        await client.request(
          'session.prompt',
          { text: 'expire this run', clientRunKey: 'socket-grace-expire' },
          { sessionId }
        )
      )
      assert.equal(typeof accepted.runId, 'string')
      await waitFor(
        () => fixture.base.provider.requests.length >= requestCount + 1,
        'held provider request before disconnect'
      )

      await client.close()
      client = undefined
      const exit = await within(fixture.exited, 'socket kernel grace-expiry exit')
      assert.deepEqual(exit, { code: 0, signal: null })

      const terminals = receipts(fixture, sessionId).filter(
        (receipt) => receipt.state === 'terminal' && receipt.runId === accepted.runId
      )
      assert.equal(terminals.length, 1, 'grace expiry must persist exactly one terminal receipt')
      const terminal = terminals[0]
      assert.equal(terminal?.status, 'cancelled')
      assert.equal(typeof terminal?.at, 'string')
      const manifest = JSON.parse(
        readFileSync(sessionPath(fixture, sessionId, 'session.json'), 'utf8')
      ) as { lastRun?: unknown }
      assert.deepEqual(manifest.lastRun, { runId: accepted.runId, status: 'cancelled' })
      assert.equal(
        existsSync(sessionPath(fixture, sessionId, 'writer.lock')),
        false,
        'closeAll must release the writer lock before exit'
      )

      peer = await fixture.spawnPeer()
      assert.deepEqual(await peer.client.request('session.open', { sessionId }), { sessionId })
      const snapshot = record(await peer.client.request('session.snapshot', {}, { sessionId }))
      assert.deepEqual(snapshot.lastRun, { runId: accepted.runId, status: 'cancelled' })
    } finally {
      await client?.close()
      await peer?.close()
      await fixture.close()
    }
  }
)
