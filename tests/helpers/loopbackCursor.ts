import http2 from 'node:http2'
import type { ModelReply, ModelRequest } from '../engine-contract/loopback-model'

function message(field: number, value: Uint8Array): Buffer {
  const bytes = [field * 8 + 2]
  let length = value.length
  do {
    bytes.push((length & 127) | (length > 127 ? 128 : 0))
    length >>>= 7
  } while (length)
  return Buffer.concat([Buffer.from(bytes), value])
}

function frame(value: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(value.length, 1)
  return Buffer.concat([header, value])
}

/** Minimal real Cursor Connect stream; an omitted turnEnded reproduces its provider error. */
export async function startLoopbackCursor(): Promise<{
  url: string
  requests: ModelRequest[]
  enqueue(...replies: ModelReply[]): void
  close(): Promise<void>
}> {
  const requests: ModelRequest[] = []
  const replies: ModelReply[] = []
  const clients = new Set<http2.ServerHttp2Session>()
  const server = http2.createServer()
  server.on('session', (session) => {
    clients.add(session)
    session.once('close', () => clients.delete(session))
  })
  server.on('stream', (stream) => {
    let pending = Buffer.alloc(0)
    let responded = false
    // Cursor's bidirectional request remains writable while it reads the answer.
    stream.on('data', (chunk: Buffer) => {
      if (responded) return
      pending = Buffer.concat([pending, chunk])
      if (pending.length < 5 || pending.length < 5 + pending.readUInt32BE(1)) return
      responded = true
      requests.push({ messages: [], bodyBase64: pending.toString('base64') })
      const reply = replies.shift()
      stream.respond({ ':status': reply ? 200 : 500, 'content-type': 'application/connect+proto' })
      if (!reply) {
        stream.end()
        return
      }
      if (reply.text) {
        stream.write(frame(message(1, message(1, message(1, Buffer.from(reply.text))))))
      }
      if (reply.tool?.name === 'todo') {
        // ToolCall.readTodosToolCall (10): a server-owned call with a real success result.
        const id = message(1, Buffer.from(reply.tool.id ?? 'todo-1'))
        const args = message(1, Buffer.alloc(0))
        const call = message(10, args)
        stream.write(frame(message(1, message(2, Buffer.concat([id, message(2, call)])))))
        const completed = message(
          10,
          Buffer.concat([args, message(2, message(1, Buffer.alloc(0)))])
        )
        stream.write(frame(message(1, message(3, Buffer.concat([id, message(2, completed)])))))
      }
      if (!reply.hold) stream.write(frame(message(1, message(14, Buffer.alloc(0)))))
      stream.end()
    })
    stream.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No Cursor fixture port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    enqueue: (...values) => replies.push(...values),
    async close() {
      for (const client of clients) client.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
