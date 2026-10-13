import { createServer, type IncomingHttpHeaders } from 'node:http'
import http2, { type ServerHttp2Stream } from 'node:http2'
import { createHash, createHmac } from 'node:crypto'
import { createCursorH2Bridge, type CursorH2Bridge } from '../../src/main/agent/cursor-h2-bridge'

export type CloudCategory =
  'google' | 'gemini' | 'antigravity' | 'bedrock' | 'vertex' | 'cursor' | 'registered'
export interface CloudReply {
  text?: string
  tool?: boolean
  hold?: boolean
}
export interface CloudRequest {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  raw: string
}
export const CLOUD_SECRETS = {
  google: 'private-google-key-fixture',
  gemini: 'private-gemini-access-fixture',
  antigravity: 'private-antigravity-access-fixture',
  cursor: 'private-cursor-access-fixture',
  registered: 'private-extension-key-fixture',
  awsId: 'AKIAPHI00000000000000',
  awsSecret: 'private-aws-secret-fixture',
  awsToken: 'private-aws-session-fixture',
  adcClient: 'private-adc-client-fixture',
  adcSecret: 'private-adc-secret-fixture',
  adcRefresh: 'private-adc-refresh-fixture',
  adcAccess: 'private-adc-access-fixture'
} as const
export const CLOUD_REFS = {
  google: { provider: 'google', id: 'phi-google' },
  gemini: { provider: 'google-gemini-cli', id: 'phi-gemini' },
  antigravity: { provider: 'google-antigravity', id: 'phi-antigravity' },
  bedrock: { provider: 'amazon-bedrock', id: 'anthropic.claude-phi-v1' },
  vertex: { provider: 'google-vertex', id: 'phi-vertex' },
  cursor: { provider: 'cursor', id: 'phi-cursor' },
  registered: { provider: 'phi-extension', id: 'phi-registered' }
} as const
const crc = (bytes: Buffer): number => {
  let result = 0xffffffff
  for (const byte of bytes) {
    result ^= byte
    for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0)
  }
  return (result ^ 0xffffffff) >>> 0
}
function awsEvent(event: string, payload: unknown): Buffer {
  const headers = Buffer.concat(
    Object.entries({
      ':message-type': 'event',
      ':event-type': event,
      ':content-type': 'application/json'
    }).map(([key, value]) => {
      const name = Buffer.from(key),
        text = Buffer.from(value),
        size = Buffer.alloc(2)
      size.writeUInt16BE(text.length)
      return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), size, text])
    })
  )
  const body = Buffer.from(JSON.stringify(payload)),
    frame = Buffer.alloc(16 + headers.length + body.length)
  frame.writeUInt32BE(frame.length)
  frame.writeUInt32BE(headers.length, 4)
  frame.writeUInt32BE(crc(frame.subarray(0, 8)), 8)
  headers.copy(frame, 12)
  body.copy(frame, 12 + headers.length)
  frame.writeUInt32BE(crc(frame.subarray(0, -4)), frame.length - 4)
  return frame
}
function bedrockReply(reply: CloudReply): Buffer {
  const events: Array<[string, unknown]> = [['messageStart', { role: 'assistant' }]]
  if (reply.tool) {
    events.push(
      [
        'contentBlockStart',
        { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'cloud-call', name: 'inspect' } } }
      ],
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: { toolUse: { input: JSON.stringify({ path: 'ordinary.txt' }) } }
        }
      ]
    )
  } else {
    events.push(
      [
        'contentBlockDelta',
        {
          contentBlockIndex: 0,
          delta: {
            reasoningContent: { text: 'private reasoning', signature: 'opaque-cloud-signature' }
          }
        }
      ],
      ['contentBlockStop', { contentBlockIndex: 0 }],
      [
        'contentBlockDelta',
        { contentBlockIndex: 1, delta: { text: reply.text ?? 'cloud 中文 answer' } }
      ]
    )
  }
  events.push(
    ['contentBlockStop', { contentBlockIndex: reply.tool ? 0 : 1 }],
    ['messageStop', { stopReason: reply.tool ? 'tool_use' : 'end_turn' }],
    ['metadata', { usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } }]
  )
  return Buffer.concat(events.map(([event, payload]) => awsEvent(event, payload)))
}
function googleReply(reply: CloudReply, cca: boolean): string {
  const parts = reply.tool
    ? [
        {
          functionCall: { name: 'inspect', id: 'cloud-call', args: { path: 'ordinary.txt' } },
          thoughtSignature: 'opaque-tool-signature'
        }
      ]
    : [
        { text: 'private reasoning', thought: true, thoughtSignature: 'opaque-cloud-signature' },
        { text: reply.text ?? 'cloud 中文 answer' }
      ]
  const chunk = {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 }
  }
  return `data: ${JSON.stringify(cca ? { response: chunk } : chunk)}\n\n`
}
function varint(value: number): Buffer {
  const bytes: number[] = []
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0))
    value = Math.floor(value / 128)
  } while (value)
  return Buffer.from(bytes)
}
function proto(field: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes])
}
function cursorUpdate(field: number, text?: string): Buffer {
  const message = proto(
    1,
    proto(field, text === undefined ? Buffer.alloc(0) : proto(1, Buffer.from(text)))
  )
  const envelope = Buffer.alloc(5)
  envelope.writeUInt32BE(message.length, 1)
  return Buffer.concat([envelope, message])
}

/** Verify SigV4 independently from the SDK, including the actual signed payload. */
export function verifyFixtureAwsSignature(request: CloudRequest, originalUrl: string): boolean {
  const auth = String(request.headers.authorization ?? '')
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(
      auth
    )
  if (!match || match[1] !== CLOUD_SECRETS.awsId) return false
  const scope = match[2].split('/'),
    url = new URL(originalUrl)
  const headerNames = match[3].split(';')
  const canonicalHeaders = headerNames
    .map(
      (name) =>
        `${name}:${String(name === 'host' ? url.host : (request.headers[name] ?? ''))
          .trim()
          .replace(/\s+/g, ' ')}\n`
    )
    .join('')
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
  const canonical = [
    'POST',
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    match[3],
    hash(request.raw)
  ].join('\n')
  const date = String(request.headers['x-amz-date'])
  const stringToSign = ['AWS4-HMAC-SHA256', date, match[2], hash(canonical)].join('\n')
  let key: Buffer = Buffer.from(`AWS4${CLOUD_SECRETS.awsSecret}`)
  for (const value of scope) key = createHmac('sha256', key).update(value).digest()
  return createHmac('sha256', key).update(stringToSign).digest('hex') === match[4]
}
export interface CloudProvider {
  url: string
  bridge: CursorH2Bridge
  enqueue(...values: CloudReply[]): number
  snapshot(): {
    requests: CloudRequest[]
    active: number
    cancellations: number
    tokenExchanges: number
  }
  reset(): void
  close(): Promise<void>
}
export async function startCloudProvider(): Promise<CloudProvider> {
  const requests: CloudRequest[] = [],
    replies: CloudReply[] = [],
    sockets = new Set<import('node:net').Socket>()
  const active = new Set<import('node:http').ServerResponse | ServerHttp2Stream>()
  let cancellations = 0,
    tokenExchanges = 0
  const server = createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const part of req) raw += part
    const path = req.url ?? '/'
    if (path.startsWith('/mapped/oauth2.googleapis.com/token')) {
      requests.push({
        path,
        headers: req.headers,
        body: Object.fromEntries(new URLSearchParams(raw)),
        raw
      })
      tokenExchanges++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          access_token: CLOUD_SECRETS.adcAccess,
          expires_in: 3600,
          token_type: 'Bearer'
        })
      )
      return
    }
    if (path.startsWith('/mapped/antigravity-hub-auto-updater-974169037036.us-central1.run.app/')) {
      res.writeHead(200, { 'content-type': 'text/yaml' })
      res.end('version: 2.19.1\n')
      return
    }
    requests.push({ path, headers: req.headers, body: JSON.parse(raw), raw })
    const reply = replies.shift() ?? {}
    if (path === '/registered') {
      if (reply.hold) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{')
        active.add(res)
        res.on('close', () => {
          active.delete(res)
          if (!res.writableEnded) cancellations++
        })
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: reply.text ?? 'cloud 中文 answer', tool: reply.tool }))
      return
    }
    const bedrock = path.includes('/model/')
    res.writeHead(200, {
      'content-type': bedrock ? 'application/vnd.amazon.eventstream' : 'text/event-stream'
    })
    active.add(res)
    res.on('close', () => {
      active.delete(res)
      if (!res.writableEnded) cancellations++
    })
    res.write(bedrock ? bedrockReply(reply) : googleReply(reply, path.includes('v1internal')))
    if (!reply.hold) res.end()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Private cloud address unavailable')
  const h2 = http2.createServer(),
    h2sessions = new Set<http2.ServerHttp2Session>()
  h2.on('session', (session) => {
    h2sessions.add(session)
    session.on('close', () => h2sessions.delete(session))
  })
  h2.on('stream', (stream, headers) => {
    let initial = true,
      received = Buffer.alloc(0),
      request: CloudRequest | undefined,
      reply: CloudReply | undefined
    const envelope = (message: Buffer): Buffer => {
      const head = Buffer.alloc(5)
      head.writeUInt32BE(message.length, 1)
      return Buffer.concat([head, message])
    }
    stream.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      while (received.length >= 5 && received.length >= 5 + received.readUInt32BE(1)) {
        const size = 5 + received.readUInt32BE(1),
          frame = received.subarray(0, size)
        received = received.subarray(size)
        if (initial) {
          initial = false
          request = {
            path: String(headers[':path']),
            headers,
            body: { requestBase64: frame.toString('base64') },
            raw: frame.toString('base64')
          }
          requests.push(request)
          reply = replies.shift() ?? {}
          stream.respond(
            { ':status': 200, 'content-type': 'application/connect+proto' },
            { waitForTrailers: true }
          )
          active.add(stream)
          stream.on('close', () => {
            active.delete(stream)
            if (reply?.hold) cancellations++
          })
          // Actual Cursor tools arrive after this exec requestContext handshake.
          // AgentServerMessage.execServerMessage=2; ExecServerMessage.id=1,
          // execId=15, requestContextArgs=10 (locked official protobuf schema).
          stream.write(
            envelope(
              proto(
                2,
                Buffer.concat([
                  Buffer.from([8, 1]),
                  proto(15, Buffer.from('private-context')),
                  proto(10, Buffer.alloc(0))
                ])
              )
            )
          )
        } else if (request && !request.body.requestContextBase64) {
          request.body.requestContextBase64 = frame.toString('base64')
          if (reply?.tool) {
            const args = Buffer.concat([
              proto(1, Buffer.from('inspect')),
              proto(
                2,
                Buffer.concat([
                  proto(1, Buffer.from('path')),
                  proto(2, Buffer.from(JSON.stringify('ordinary.txt')))
                ])
              ),
              proto(3, Buffer.from('cloud-call')),
              proto(5, Buffer.from('inspect'))
            ])
            stream.write(
              envelope(
                proto(
                  2,
                  Buffer.concat([
                    Buffer.from([8, 2]),
                    proto(15, Buffer.from('private-mcp')),
                    proto(11, args)
                  ])
                )
              )
            )
          } else {
            stream.write(cursorUpdate(4, 'private reasoning'))
            stream.write(cursorUpdate(1, reply?.text ?? 'cloud 中文 answer'))
            if (!reply?.hold) {
              stream.write(cursorUpdate(5))
              stream.write(cursorUpdate(14))
              stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
              stream.end()
            }
          }
        } else if (request && reply?.tool && !request.body.mcpResultBase64) {
          request.body.mcpResultBase64 = frame.toString('base64')
          stream.write(cursorUpdate(14))
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
          stream.end()
        }
      }
    })
    stream.on('error', () => {})
  })
  await new Promise<void>((resolve) => h2.listen(0, '127.0.0.1', resolve))
  const h2address = h2.address()
  if (!h2address || typeof h2address === 'string')
    throw new Error('Private cursor address unavailable')
  const bridge = createCursorH2Bridge(`http://127.0.0.1:${h2address.port}`)
  return {
    url: `http://127.0.0.1:${address.port}`,
    bridge,
    enqueue: (...values: CloudReply[]) => replies.push(...values),
    snapshot: () => ({
      requests: [...requests],
      active: active.size,
      cancellations,
      tokenExchanges
    }),
    reset: () => {
      requests.length = 0
      cancellations = 0
    },
    async close() {
      await bridge.close()
      for (const response of active) response.destroy()
      for (const session of h2sessions) session.destroy()
      for (const socket of sockets) socket.destroy()
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => h2.close(() => resolve()))
      ])
    }
  }
}
