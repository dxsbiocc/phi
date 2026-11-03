import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createConnection, type AddressInfo, type Socket } from 'node:net'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  KernelProtocolClient,
  spawnKernelStdio,
  type KernelClientTransport,
  type SpawnedKernelClient
} from '../src/main/agent/engine/kernel-client'
import { SUPERSEDE_SIGNAL } from '../src/kernel/sessions/superseded-writer'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import type { JsonValue, KernelEventFrame } from '../src/shared/kernel-protocol'
import { createInProcessFixture } from './engine-contract/in-process-factory'

const TOKEN = '7b'.repeat(32)
const MODEL_GATEWAY_BEARER = '8c'.repeat(32)

type NativeGatewayReply = {
  text?: string
  tool?: { name: string; id: string; args: Record<string, unknown> }
  waitFor?: Promise<void>
  hold?: boolean
}

type NativeGatewayFixture = {
  endpoint: string
  requests: Array<Record<string, unknown>>
  enqueue(reply: NativeGatewayReply): void
  close(): Promise<void>
}

type SocketKernelFixture = {
  base: Awaited<ReturnType<typeof createInProcessFixture>>
  modelGateway: NativeGatewayFixture
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

async function startLoopbackNativeGateway(model: {
  provider: string
  id: string
}): Promise<NativeGatewayFixture> {
  const requests: Array<Record<string, unknown>> = []
  const replies: NativeGatewayReply[] = []
  const active = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    active.add(response)
    response.once('close', () => active.delete(response))
    try {
      if (
        request.method !== 'POST' ||
        request.url !== '/v1/pi/stream' ||
        request.headers.authorization !== `Bearer ${MODEL_GATEWAY_BEARER}`
      ) {
        response.writeHead(401).end('Unexpected model gateway request')
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      const parsed = JSON.parse(body) as Record<string, unknown>
      if (parsed.modelId !== `${model.provider}/${model.id}`) {
        response.writeHead(400).end('Unexpected model gateway model')
        return
      }
      requests.push(parsed)
      const reply = replies.shift()
      if (!reply) {
        response.writeHead(500).end('No scripted model gateway reply remains')
        return
      }
      const stopReason = reply.tool ? 'toolUse' : 'stop'
      const content = reply.tool
        ? [
            {
              type: 'toolCall',
              id: reply.tool.id,
              name: reply.tool.name,
              arguments: reply.tool.args
            }
          ]
        : [{ type: 'text', text: reply.text ?? '' }]
      const message = {
        role: 'assistant',
        api: 'openai-completions',
        provider: model.provider,
        model: model.id,
        content,
        stopReason,
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (value: unknown): void => {
        response.write(`data: ${JSON.stringify(value)}\n\n`)
      }
      event({ type: 'start', partial: { ...message, content: [] } })
      if (reply.tool) {
        const toolCall = content[0]
        event({ type: 'toolcall_start', contentIndex: 0, partial: message })
        event({
          type: 'toolcall_delta',
          contentIndex: 0,
          delta: JSON.stringify(reply.tool.args),
          partial: message
        })
        event({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message })
      } else {
        const text = reply.text ?? ''
        event({ type: 'text_start', contentIndex: 0, partial: message })
        event({ type: 'text_delta', contentIndex: 0, delta: text, partial: message })
        event({ type: 'text_end', contentIndex: 0, content: text, partial: message })
      }
      await reply.waitFor
      if (reply.hold) return
      event({ type: 'done', reason: stopReason, message })
      response.end('data: [DONE]\n\n')
    } catch (error) {
      if (!response.headersSent) response.writeHead(500).end(String(error))
      else response.destroy()
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/pi/stream`,
    requests,
    enqueue: (reply) => replies.push(reply),
    async close() {
      for (const response of active) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  }
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
  const modelGateway = await startLoopbackNativeGateway(base.model)
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
    await client.request('modelAccess.configure', {
      endpoint: modelGateway.endpoint,
      bearerToken: MODEL_GATEWAY_BEARER,
      models: [
        {
          provider: base.model.provider,
          id: base.model.id,
          name: base.model.name,
          reasoning: base.model.reasoning,
          input: ['text'],
          contextWindow: 32_768,
          maxTokens: 256,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
      ]
    })
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
      try {
        await modelGateway.close()
      } finally {
        await base.close()
      }
      rmSync(runtimeDirectory, { recursive: true, force: true })
    })()
    return closing
  }

  const fixtureWithoutClient = {
    base,
    modelGateway,
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
  'remote socket kernel request is accepted by the desktop model gateway validator',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await startSocketKernel(t, 5_000)
    if (!fixture) return
    const client = fixture.initialClient
    try {
      const created = record(
        await client.request('session.create', {
          cwd: fixture.base.cwd,
          model: { provider: fixture.base.model.provider, id: fixture.base.model.id },
          sessionManager: { kind: 'memory' },
          noTools: 'all',
          enableToolApproval: false,
          autoCompaction: { enabled: false }
        })
      )
      const requestCount = fixture.modelGateway.requests.length
      fixture.modelGateway.enqueue({ text: 'desktop gateway accepted remote kernel request' })
      await client.request(
        'session.prompt',
        { text: 'send the remote provider request' },
        { sessionId: String(created.sessionId) }
      )
      await waitFor(
        () => fixture.modelGateway.requests.length === requestCount + 1,
        'remote kernel model request'
      )

      const captured = fixture.modelGateway.requests.at(-1)
      assert.ok(captured)
      assert.equal(captured.modelId, `${fixture.base.model.provider}/${fixture.base.model.id}`)
      assert.equal(
        record(captured.options as JsonValue).credentialId,
        undefined,
        'the wire projection must keep the remote-local credential row off the desktop request'
      )

      const desktopLease = await fixture.base.createModelGatewayLease({
        sessionId: 'remote-shape-validation',
        generation: 1,
        models: [{ provider: fixture.base.model.provider, id: fixture.base.model.id }]
      })
      fixture.base.provider.enqueue({ text: 'real desktop gateway accepted remote shape' })
      const response = await fetch(`http://127.0.0.1:${desktopLease.localPort}/v1/pi/stream`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${desktopLease.bearerToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(captured)
      })
      const responseBody = await response.text()
      assert.equal(response.status, 200, responseBody)
      assert.match(responseBody, /real desktop gateway accepted remote shape/u)
    } finally {
      await client.close()
      await fixture.close()
    }
  }
)

test(
  'client-proxy models survive creating session B while session A waits in a native tool call',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await startSocketKernel(t, 5_000)
    if (!fixture) return
    const client = fixture.initialClient
    const events: KernelEventFrame[] = []
    const stopEvents = client.onEvent((event) => events.push(event))
    try {
      const createdA = record(
        await client.request('session.create', {
          cwd: fixture.base.cwd,
          model: { provider: fixture.base.model.provider, id: fixture.base.model.id },
          sessionManager: { kind: 'memory' },
          enableToolApproval: true,
          autoCompaction: { enabled: false }
        })
      )
      const sessionA = String(createdA.sessionId)
      fixture.modelGateway.enqueue({
        tool: {
          name: 'write',
          id: 'held-write-a',
          args: { path: join(fixture.base.cwd, 'must-not-write.txt'), content: 'blocked' }
        }
      })
      const acceptedA = record(
        await client.request(
          'session.prompt',
          { text: 'request a held write' },
          { sessionId: sessionA }
        )
      )
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === 'approval.requested' &&
              event.sessionId === sessionA &&
              record(event.payload).toolCallId === 'held-write-a'
          ),
        'session A native tool approval'
      )

      const createdB = record(
        await client.request('session.create', {
          cwd: fixture.base.cwd,
          model: { provider: fixture.base.model.provider, id: fixture.base.model.id },
          sessionManager: { kind: 'memory' },
          noTools: 'all',
          enableToolApproval: false,
          autoCompaction: { enabled: false }
        })
      )
      const sessionB = String(createdB.sessionId)
      const snapshotB = record(
        await client.request('session.snapshot', {}, { sessionId: sessionB })
      )
      assert.deepEqual(snapshotB.model, {
        provider: fixture.base.model.provider,
        id: fixture.base.model.id
      })

      fixture.modelGateway.enqueue({ text: 'session B kept its client-proxy model' })
      const acceptedB = record(
        await client.request('session.prompt', { text: 'run session B' }, { sessionId: sessionB })
      )
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === 'run.completed' &&
              event.sessionId === sessionB &&
              record(event.payload).runId === acceptedB.runId &&
              record(event.payload).status === 'completed'
          ),
        'session B completion'
      )
      const completedB = record(
        await client.request('session.snapshot', {}, { sessionId: sessionB })
      )
      assert.ok(
        JSON.stringify(completedB.messages).includes('session B kept its client-proxy model')
      )

      await client.request('session.abort', {}, { sessionId: sessionA })
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === 'run.completed' &&
              event.sessionId === sessionA &&
              record(event.payload).runId === acceptedA.runId
          ),
        'session A cancellation'
      )
    } finally {
      stopEvents()
      await client.close()
      await fixture.close()
    }
  }
)

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
      const requestCount = fixture.modelGateway.requests.length
      fixture.modelGateway.enqueue({
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
        () => fixture.modelGateway.requests.length >= requestCount + 1,
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
      const catalog = record(await client.request('models.catalog', {}))
      assert.deepEqual(catalog.providers, [
        { provider: fixture.base.model.provider, status: 'available' }
      ])
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
      const requestCount = fixture.modelGateway.requests.length
      fixture.modelGateway.enqueue({ text: 'held until grace expiry', hold: true })
      const accepted = record(
        await client.request(
          'session.prompt',
          { text: 'expire this run', clientRunKey: 'socket-grace-expire' },
          { sessionId }
        )
      )
      assert.equal(typeof accepted.runId, 'string')
      await waitFor(
        () => fixture.modelGateway.requests.length >= requestCount + 1,
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

test(
  'an idle socket kernel releases its sessions when a newer build asks, an attached one does not',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await startSocketKernel(t, 600_000)
    if (!fixture) return
    let client: KernelProtocolClient | undefined
    try {
      client = fixture.initialClient
      const sessionId = await createPersistentSession(fixture, client)
      const lock = sessionPath(fixture, sessionId, 'writer.lock')
      assert.equal(existsSync(lock), true)

      // A desktop is attached: the session is in use and stays with this kernel.
      fixture.child.kill(SUPERSEDE_SIGNAL)
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      assert.equal(fixture.child.exitCode, null)
      assert.equal(existsSync(lock), true)

      await client.close()
      client = undefined
      fixture.child.kill(SUPERSEDE_SIGNAL)
      const exit = await within(fixture.exited, 'superseded idle kernel exit')
      assert.deepEqual(exit, { code: 0, signal: null })
      assert.equal(existsSync(lock), false, 'the newer kernel can now open the session')
    } finally {
      await client?.close()
      await fixture.close()
    }
  }
)
