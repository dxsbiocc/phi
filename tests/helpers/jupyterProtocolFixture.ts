import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { JupyterServerConnection } from '../../src/main/agent/notebook/analysis-jupyter-server'

export type ProtocolExecution = {
  kernelId: string
  sessionId: string
  msgId: string
  code: string
  socket: Socket
}

function frame(text: string): Buffer {
  const payload = Buffer.from(text)
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4)
  header[0] = 0x81
  header[1] = payload.length < 126 ? payload.length : 126
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

/** Isolated Jupyter HTTP/WS protocol peer; production session/kernel clients do all I/O. */
export type JupyterProtocolFixture = {
  connection: JupyterServerConnection
  executions: ProtocolExecution[]
  interrupts: string[]
  sessions: Array<{ path: string; id: string; kernelId: string }>
  holdSessionCreates(): void
  releaseSessionCreates(): void
  holdInterruptAcknowledgements(): void
  acknowledgeInterrupts(): void
  stream(execution: ProtocolExecution, text: string): void
  finish(execution: ProtocolExecution, text?: string, status?: string): void
  close(): Promise<void>
}

export async function startJupyterProtocolFixture(): Promise<JupyterProtocolFixture> {
  const executions: ProtocolExecution[] = []
  const interrupts: string[] = []
  const sessions: Array<{ path: string; id: string; kernelId: string }> = []
  const sockets = new Set<Socket>()
  const heldCreates: Array<() => void> = []
  const heldInterrupts: ServerResponse[] = []
  let holdCreates = false
  let holdInterrupts = false
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'set-cookie': '_xsrf=fixture; Path=/' }).end('Jupyter')
      return
    }
    if (
      request.headers['x-xsrftoken'] !== 'fixture' ||
      request.headers.cookie !== '_xsrf=fixture'
    ) {
      response.writeHead(403).end('XSRF required')
      return
    }
    if (request.method === 'POST' && request.url === '/api/sessions') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body) as { path: string; kernel: { name: string } }
      const index = sessions.length + 1
      const session = { path: input.path, id: `session-${index}`, kernelId: `kernel-${index}` }
      sessions.push(session)
      const complete = (): void => {
        response.writeHead(201, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: session.id,
            kernel: { id: session.kernelId, name: input.kernel.name, execution_state: 'idle' }
          })
        )
      }
      if (holdCreates) heldCreates.push(complete)
      else complete()
      return
    }
    const interrupt = request.url?.match(/^\/api\/kernels\/([^/]+)\/interrupt$/)
    if (request.method === 'POST' && interrupt) {
      interrupts.push(decodeURIComponent(interrupt[1]))
      if (holdInterrupts) heldInterrupts.push(response)
      else response.writeHead(204).end()
      return
    }
    if (request.method === 'DELETE' && request.url?.startsWith('/api/sessions/')) {
      response.writeHead(204).end()
      return
    }
    response.writeHead(404).end('Unexpected Jupyter endpoint')
  })
  server.on('upgrade', (request, duplex) => {
    const socket = duplex as Socket
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const key = request.headers['sec-websocket-key']
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 0x0f
        const masked = Boolean(buffered[1] & 0x80)
        let length = buffered[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffered.length < 4) return
          length = buffered.readUInt16BE(2)
          offset = 4
        }
        if (length === 127) throw new Error('Fixture accepts bounded Jupyter frames only')
        const mask = masked ? buffered.subarray(offset, offset + 4) : undefined
        if (masked) offset += 4
        if (buffered.length < offset + length) return
        const payload = Buffer.from(buffered.subarray(offset, offset + length))
        buffered = buffered.subarray(offset + length)
        if (mask)
          for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]))
          return
        }
        if (opcode !== 1) continue
        const message = JSON.parse(payload.toString()) as {
          header: { msg_id: string; session: string; msg_type: string }
          content: { code: string }
        }
        if (message.header.msg_type !== 'execute_request')
          throw new Error('Unexpected Jupyter request')
        const url = new URL(request.url!, 'http://fixture')
        executions.push({
          kernelId: url.pathname.split('/')[3],
          sessionId: message.header.session,
          msgId: message.header.msg_id,
          code: message.content.code,
          socket
        })
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const connection: JupyterServerConnection = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    runtimeId: 'protocol-fixture'
  }
  const send = (execution: ProtocolExecution, type: string, content: unknown): void => {
    if (!execution.socket.destroyed)
      execution.socket.write(
        frame(
          JSON.stringify({
            header: { msg_type: type },
            parent_header: { msg_id: execution.msgId },
            content
          })
        )
      )
  }
  return {
    connection,
    executions,
    interrupts,
    sessions,
    holdSessionCreates(): void {
      holdCreates = true
    },
    releaseSessionCreates(): void {
      holdCreates = false
      heldCreates.splice(0).forEach((release) => release())
    },
    holdInterruptAcknowledgements(): void {
      holdInterrupts = true
    },
    acknowledgeInterrupts(): void {
      holdInterrupts = false
      heldInterrupts.splice(0).forEach((response) => response.writeHead(204).end())
    },
    stream(execution: ProtocolExecution, text: string): void {
      send(execution, 'stream', { name: 'stdout', text })
    },
    finish(execution: ProtocolExecution, text = 'result\n', status = 'ok'): void {
      send(execution, 'stream', { name: 'stdout', text })
      send(execution, 'execute_reply', { status, execution_count: 1 })
      send(execution, 'status', { execution_state: 'idle' })
    },
    async close(): Promise<void> {
      heldInterrupts.splice(0).forEach((response) => response.destroy())
      heldCreates.splice(0).forEach((release) => release())
      sockets.forEach((socket) => socket.destroy())
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

export async function waitForJupyter(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Jupyter fixture condition timed out')
}
