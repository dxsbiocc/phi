import { createHash, timingSafeEqual } from 'node:crypto'
import http2, {
  type ClientHttp2Session,
  type Http2Server,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream
} from 'node:http2'

import { CURSOR_DEFAULT_BASE_URL, CURSOR_RUN_PATH } from '../omp-cursor-wire'

const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_REQUEST_BYTES = 128 * 1024 * 1024
const REQUEST_HEADER_NAMES = [
  'content-type',
  'connect-protocol-version',
  'x-cursor-client-type',
  'x-cursor-client-version',
  'x-ghost-mode',
  'x-request-id',
  'x-original-request-id',
  'te'
] as const
const RESPONSE_HEADER_NAMES = new Set([
  'content-type',
  'content-encoding',
  'connect-content-encoding',
  'connect-accept-encoding'
])

export interface ScopedCursorH2GatewayOptions {
  /** An unpredictable token minted for one remote runtime generation. */
  token: string
  /** Exact modelDetails IDs authorized by that generation's model lease. */
  allowedModelIds: readonly string[]
  /** Resolves the current real credential only after the request model is checked. */
  resolveBearer: (wireModelId: string) => Promise<string>
  signal?: AbortSignal
  /** Only used by local tests; production always uses Cursor's origin. */
  upstreamOrigin?: string
}

export interface ScopedCursorH2Gateway {
  port: number
  close(): Promise<void>
}

function sameToken(expected: string, received: unknown): boolean {
  if (typeof received !== 'string' || !received.startsWith('Bearer ')) return false
  const supplied = createHash('sha256').update(received.slice(7)).digest()
  const correct = createHash('sha256').update(expected).digest()
  return timingSafeEqual(supplied, correct)
}

function reject(stream: ServerHttp2Stream, status: number): void {
  if (stream.destroyed || stream.headersSent) return
  stream.respond({ ':status': status })
  stream.end()
}

async function* incomingParts(stream: ServerHttp2Stream): AsyncGenerator<Buffer> {
  const queue: Buffer[] = []
  let ended = false
  let wake: (() => void) | undefined
  const onData = (part: Buffer): void => {
    queue.push(part)
    stream.pause()
    wake?.()
  }
  const onEnd = (): void => {
    ended = true
    wake?.()
  }
  stream.on('data', onData)
  stream.once('end', onEnd)
  stream.once('close', onEnd)
  try {
    while (!ended || queue.length) {
      if (queue.length) yield queue.shift()!
      else {
        stream.resume()
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      wake = undefined
    }
  } finally {
    stream.off('data', onData)
    stream.off('end', onEnd)
    stream.off('close', onEnd)
  }
}

interface WireField {
  number: number
  wireType: number
  data: Buffer
}

/** Read only the known protobuf envelope. Duplicate fields are rejected instead of last-wins. */
function fields(bytes: Buffer): WireField[] {
  let offset = 0
  const result: WireField[] = []
  function varint(): number {
    let value = 0
    let factor = 1
    for (let count = 0; count < 10 && offset < bytes.length; count++) {
      const octet = bytes[offset++]
      value += (octet & 0x7f) * factor
      if (octet < 0x80) {
        if (!Number.isSafeInteger(value)) throw new Error('invalid protobuf integer')
        return value
      }
      factor *= 128
    }
    throw new Error('invalid protobuf integer')
  }
  while (offset < bytes.length) {
    const tag = varint()
    const number = Math.floor(tag / 8)
    const wireType = tag % 8
    if (number < 1 || number > 100_000 || ![0, 1, 2, 5].includes(wireType)) {
      throw new Error('invalid protobuf tag')
    }
    const start = offset
    if (wireType === 0) varint()
    else if (wireType === 1) offset += 8
    else if (wireType === 5) offset += 4
    else {
      const length = varint()
      if (length > bytes.length - offset) throw new Error('invalid protobuf length')
      result.push({ number, wireType, data: bytes.subarray(offset, offset + length) })
      offset += length
      continue
    }
    if (offset > bytes.length) throw new Error('invalid protobuf length')
    result.push({ number, wireType, data: bytes.subarray(start, offset) })
  }
  return result
}

function onlyField(list: WireField[], number: number): WireField {
  const matches = list.filter((field) => field.number === number)
  if (matches.length !== 1 || matches[0].wireType !== 2)
    throw new Error('missing or duplicate field')
  return matches[0]
}

function modelId(bytes: Buffer, kind: 'details' | 'requested'): string {
  const list = fields(bytes)
  // The generated pi-catalog schema defines credentials as 8-10 or 4-6.
  // Rich parameter routes and max mode need a more precise lease descriptor.
  if (
    list.some((field) =>
      kind === 'details'
        ? field.number > 7 || (field.number === 7 && field.data.some((octet) => octet !== 0))
        : field.number > 2 || (field.number === 2 && field.data.some((octet) => octet !== 0))
    )
  ) {
    throw new Error('unsupported model route or credentials')
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(onlyField(list, 1).data)
}

function checkedModel(payload: Buffer, allowed: ReadonlySet<string>): string {
  const envelope = fields(payload)
  if (envelope.length !== 1) throw new Error('invalid run envelope')
  const run = onlyField(envelope, 1)
  const request = fields(run.data)
  if (request.some((field) => field.number > 9)) throw new Error('unknown run field')
  const details = modelId(onlyField(request, 3).data, 'details')
  const requested = modelId(onlyField(request, 9).data, 'requested')
  // Rich Cursor routes can use different requested and display IDs. Until the lease
  // carries exact route pairs, reject those routes instead of guessing their scope.
  if (!details || details !== requested || !allowed.has(details)) {
    throw new Error('model outside lease')
  }
  return details
}

/** A desktop-only h2c endpoint that never exposes the real Cursor bearer to the worker. */
export async function createScopedCursorH2Gateway(
  options: ScopedCursorH2GatewayOptions
): Promise<ScopedCursorH2Gateway> {
  if (!options.token || !options.allowedModelIds.length || options.signal?.aborted) {
    throw new Error('Cursor gateway requires an active scoped lease')
  }
  const allowed = new Set(options.allowedModelIds)
  const sessions = new Set<ServerHttp2Session>()
  const upstreamSessions = new Set<ClientHttp2Session>()
  const streams = new Set<ServerHttp2Stream>()
  let retired = false
  let closing: Promise<void> | undefined
  const server: Http2Server = http2.createServer()

  server.on('session', (session) => {
    sessions.add(session)
    session.once('close', () => sessions.delete(session))
  })
  server.on('stream', (stream, headers) => {
    streams.add(stream)
    stream.once('close', () => streams.delete(stream))
    if (
      retired ||
      headers[':method'] !== 'POST' ||
      headers[':path'] !== CURSOR_RUN_PATH ||
      headers[':scheme'] !== 'http' ||
      !sameToken(options.token, headers.authorization) ||
      headers['content-type'] !== 'application/connect+proto' ||
      headers['connect-protocol-version'] !== '1' ||
      (headers.te !== undefined && headers.te !== 'trailers')
    ) {
      reject(stream, 403)
      return
    }

    // Parse and bound every Connect frame before forwarding it. In particular,
    // a second runRequest cannot change models after the first was authorized.
    void (async () => {
      let pending = Buffer.alloc(0)
      let total = 0
      let first = true
      let upstream: ClientHttp2Session | undefined
      let request: ReturnType<ClientHttp2Session['request']> | undefined
      let responded = false
      const fail = (status: number): void => {
        if (request && !request.closed) request.close()
        if (upstream && !upstream.closed) upstream.destroy()
        if (!responded) reject(stream, status)
        else if (!stream.destroyed) stream.close()
      }
      stream.once('close', () => {
        if (request && !request.closed) request.close()
        if (upstream && !upstream.closed) upstream.destroy()
      })
      try {
        for await (const part of incomingParts(stream)) {
          if (retired) throw new Error('retired')
          total += part.length
          if (total > MAX_REQUEST_BYTES) throw new Error('request too large')
          pending = Buffer.concat([pending, part])
          while (pending.length >= 5) {
            const length = pending.readUInt32BE(1)
            if (pending[0] !== 0 || length > MAX_FRAME_BYTES) throw new Error('invalid frame')
            if (pending.length < length + 5) break
            const frame = pending.subarray(0, length + 5)
            pending = pending.subarray(length + 5)
            if (first) {
              const modelId = checkedModel(frame.subarray(5), allowed)
              first = false
              const bearer = await options.resolveBearer(modelId)
              if (retired || options.signal?.aborted || !bearer || /[\r\n]/.test(bearer)) {
                throw new Error('credential unavailable')
              }
              upstream = http2.connect(options.upstreamOrigin ?? CURSOR_DEFAULT_BASE_URL)
              upstreamSessions.add(upstream)
              upstream.once('close', () => upstreamSessions.delete(upstream!))
              upstream.on('error', () => fail(502))
              const requestHeaders: OutgoingHttpHeaders = {
                ':method': 'POST',
                ':path': CURSOR_RUN_PATH,
                authorization: `Bearer ${bearer}`
              }
              for (const name of REQUEST_HEADER_NAMES) {
                const value = headers[name]
                if (typeof value === 'string') requestHeaders[name] = value
              }
              request = upstream.request(requestHeaders)
              request.on('response', (incoming) => {
                if (stream.destroyed || stream.closed) return
                const outgoing: OutgoingHttpHeaders = { ':status': incoming[':status'] ?? 502 }
                for (const [name, value] of Object.entries(incoming)) {
                  if (RESPONSE_HEADER_NAMES.has(name) && value !== undefined) outgoing[name] = value
                }
                stream.respond(outgoing, { waitForTrailers: true })
                responded = true
                request!.pipe(stream, { end: false })
              })
              let trailers: IncomingHttpHeaders = {}
              request.on('trailers', (value) => {
                trailers = value
              })
              stream.on('wantTrailers', () => {
                if (!stream.destroyed) {
                  const forwarded: OutgoingHttpHeaders = {}
                  for (const name of ['grpc-status', 'grpc-message']) {
                    if (typeof trailers[name] === 'string') forwarded[name] = trailers[name]
                  }
                  stream.sendTrailers(forwarded)
                }
              })
              request.on('end', () => {
                if (!stream.destroyed && !stream.closed) stream.end()
                upstream?.close()
              })
              request.on('error', () => fail(502))
            } else {
              const message = fields(frame.subarray(5))
              if (
                message.length !== 1 ||
                message[0].number < 2 ||
                message[0].number > 8 ||
                message[0].wireType !== 2
              ) {
                throw new Error('unexpected run')
              }
            }
            if (!request || request.closed) throw new Error('upstream unavailable')
            if (!request.write(frame)) {
              await new Promise<void>((resolve) => {
                request!.once('drain', resolve)
                request!.once('close', resolve)
              })
            }
          }
          if (pending.length > MAX_FRAME_BYTES + 5) throw new Error('frame too large')
        }
        if (first || pending.length || !request) throw new Error('incomplete request')
        request.end()
      } catch {
        fail(403)
      }
    })()
  })

  const close = async (): Promise<void> => {
    if (closing) return closing
    retired = true
    options.signal?.removeEventListener('abort', onAbort)
    for (const stream of streams) stream.destroy()
    for (const session of sessions) session.destroy()
    for (const session of upstreamSessions) session.destroy()
    closing = new Promise<void>((resolve) => server.close(() => resolve()))
    return closing
  }
  const onAbort = (): void => {
    void close()
  }
  try {
    await new Promise<void>((resolve, rejectStart) => {
      server.once('error', rejectStart)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', rejectStart)
        resolve()
      })
    })
    server.on('error', () => {
      void close()
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Cursor gateway address unavailable')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) throw new Error('Cursor gateway lease retired')
    return { port: address.port, close }
  } catch (error) {
    await close()
    throw error
  }
}
