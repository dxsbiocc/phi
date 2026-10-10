import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WebSocketJupyterKernelClient,
  type KernelWebSocket,
  type KernelWebSocketConstructor,
  type KernelWebSocketEvent,
  type JupyterKernelExecuteResult,
  type RawJupyterKernelMessage
} from '../src/main/agent/notebook/analysis-jupyter-execution'
import type { JupyterServerConnection } from '../src/main/agent/notebook/analysis-jupyter-server'

const REMOTE_TOKEN = 'remote-websocket-secret'

class FakeKernelWebSocket implements KernelWebSocket {
  static instances: FakeKernelWebSocket[] = []
  readonly sent: string[] = []
  readonly listeners = {
    open: [] as Array<() => void>,
    message: [] as Array<(event: KernelWebSocketEvent) => void>,
    error: [] as Array<(event: KernelWebSocketEvent) => void>,
    close: [] as Array<() => void>
  }
  closed = false

  constructor(readonly url: string) {
    FakeKernelWebSocket.instances.push(this)
    queueMicrotask(() => this.listeners.open.forEach((listener) => listener()))
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  addEventListener(
    event: 'open' | 'message' | 'error' | 'close',
    listener: (() => void) | ((event: KernelWebSocketEvent) => void)
  ): void {
    const listeners = this.listeners[event] as Array<typeof listener>
    listeners.push(listener)
  }

  emitMessage(message: RawJupyterKernelMessage): void {
    const event = { data: JSON.stringify(message) }
    this.listeners.message.forEach((listener) => listener(event))
  }

  emitClose(): void {
    this.listeners.close.forEach((listener) => listener())
  }
}

const FakeWebSocketConstructor = FakeKernelWebSocket as unknown as KernelWebSocketConstructor

function connection(): JupyterServerConnection {
  return {
    url: 'http://127.0.0.1:41001/',
    runtimeId: 'runtime-remote-1',
    authorizationHeader: () => `token ${REMOTE_TOKEN}`
  }
}

function execute(client: WebSocketJupyterKernelClient): Promise<JupyterKernelExecuteResult> {
  return client.executeCode({
    connection: connection(),
    sessionId: 'session-1',
    kernelId: 'kernel-1',
    code: 'print("done")'
  })
}

async function openedSocket(): Promise<{
  socket: FakeKernelWebSocket
  request: { header: { msg_id: string; msg_type: string }; content: Record<string, unknown> }
}> {
  await new Promise((resolve) => setImmediate(resolve))
  const socket = FakeKernelWebSocket.instances.at(-1)
  assert.ok(socket)
  assert.equal(socket.sent.length, 1)
  return { socket, request: JSON.parse(socket.sent[0]) }
}

function kernelMessage(
  msgId: string,
  msgType: string,
  content: Record<string, unknown>
): RawJupyterKernelMessage {
  return {
    header: { msg_type: msgType },
    parent_header: { msg_id: msgId },
    content
  }
}

test.beforeEach(() => {
  FakeKernelWebSocket.instances = []
})

test('WebSocket client sends one execute request with token in the tunneled URL and waits for reply plus idle', async () => {
  const client = new WebSocketJupyterKernelClient({
    webSocketConstructor: FakeWebSocketConstructor,
    executionTimeoutMs: 1_000
  })
  let settled = false
  const execution = execute(client).finally(() => {
    settled = true
  })
  const { socket, request } = await openedSocket()

  const url = new URL(socket.url)
  assert.equal(url.protocol, 'ws:')
  assert.equal(url.host, '127.0.0.1:41001')
  assert.equal(url.pathname, '/api/kernels/kernel-1/channels')
  assert.equal(url.searchParams.get('session_id'), 'session-1')
  assert.equal(url.searchParams.get('token'), REMOTE_TOKEN)
  assert.equal(request.header.msg_type, 'execute_request')
  assert.equal(request.content.code, 'print("done")')

  socket.emitMessage(
    kernelMessage(request.header.msg_id, 'execute_reply', {
      status: 'ok',
      execution_count: 9
    })
  )
  await Promise.resolve()
  assert.equal(settled, false)
  socket.emitMessage(
    kernelMessage(request.header.msg_id, 'stream', {
      name: 'stdout',
      text: 'done\n'
    })
  )
  socket.emitMessage(kernelMessage(request.header.msg_id, 'status', { execution_state: 'idle' }))

  const result = await execution
  assert.equal(result.executionCount, 9)
  assert.equal(result.outputs[0]?.text, 'done\n')
  assert.equal(socket.sent.length, 1)
  assert.equal(socket.closed, true)
})

test('WebSocket client returns an error output only after execute_reply and idle', async () => {
  const client = new WebSocketJupyterKernelClient({
    webSocketConstructor: FakeWebSocketConstructor,
    executionTimeoutMs: 1_000
  })
  const execution = execute(client)
  const { socket, request } = await openedSocket()

  socket.emitMessage(
    kernelMessage(request.header.msg_id, 'error', {
      ename: 'ValueError',
      evalue: 'bad value',
      traceback: ['ValueError: bad value']
    })
  )
  socket.emitMessage(
    kernelMessage(request.header.msg_id, 'execute_reply', {
      status: 'error',
      execution_count: 4
    })
  )
  socket.emitMessage(kernelMessage(request.header.msg_id, 'status', { execution_state: 'idle' }))

  const result = await execution
  assert.equal(result.status, 'error')
  assert.deepEqual(result.outputs[0], {
    outputType: 'error',
    data: {},
    metadata: {},
    ename: 'ValueError',
    evalue: 'bad value',
    traceback: ['ValueError: bad value'],
    extra: {}
  })
})

test('WebSocket client accepts a short execution timeout substitute', async () => {
  const client = new WebSocketJupyterKernelClient({
    webSocketConstructor: FakeWebSocketConstructor,
    executionTimeoutMs: 5
  })
  const execution = execute(client)
  const { socket } = await openedSocket()

  await assert.rejects(execution, /Notebook cell execution timed out/)
  assert.equal(socket.closed, true)
  assert.equal(socket.sent.length, 1)
})

test('WebSocket close rejects without reconnecting, replaying, or exposing the token', async () => {
  const client = new WebSocketJupyterKernelClient({
    webSocketConstructor: FakeWebSocketConstructor,
    executionTimeoutMs: 1_000
  })
  const execution = execute(client)
  const { socket } = await openedSocket()
  socket.emitClose()

  let message = ''
  await assert.rejects(execution, (error) => {
    message = error instanceof Error ? error.message : String(error)
    return /closed before execution completed/.test(message)
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(FakeKernelWebSocket.instances.length, 1)
  assert.equal(socket.sent.length, 1)
  assert.doesNotMatch(message, new RegExp(REMOTE_TOKEN))
  assert.doesNotMatch(message, /token=/)
})
