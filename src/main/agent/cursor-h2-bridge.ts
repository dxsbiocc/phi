import http2, {
  type ClientHttp2Session,
  type Http2Server,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream
} from 'node:http2'

const CURSOR_ORIGIN = 'https://api2.cursor.sh'
const CURSOR_RUN_PATH = '/agent.v1.AgentService/Run'

export interface CursorH2Bridge {
  ensure(): Promise<string>
  close(): Promise<void>
}

/** Bun speaks h2c to this loopback-only endpoint; Node handles Cursor's TLS HTTP/2 leg. */
export function createCursorH2Bridge(upstreamOrigin = CURSOR_ORIGIN): CursorH2Bridge {
  let server: Http2Server | null = null
  let starting: Promise<string> | null = null
  const localSessions = new Set<ServerHttp2Session>()
  const upstreamSessions = new Set<ClientHttp2Session>()

  function reject(stream: ServerHttp2Stream, status: number): void {
    if (stream.destroyed) return
    stream.respond({ ':status': status })
    stream.end()
  }

  function forward(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
    if (
      headers[':method'] !== 'POST' ||
      headers[':path'] !== CURSOR_RUN_PATH ||
      typeof headers.authorization !== 'string' ||
      !headers.authorization.startsWith('Bearer ')
    ) {
      reject(stream, 403)
      return
    }

    const upstream = http2.connect(upstreamOrigin)
    upstreamSessions.add(upstream)
    const requestHeaders: OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': CURSOR_RUN_PATH
    }
    for (const [name, value] of Object.entries(headers)) {
      if (!name.startsWith(':') && value !== undefined) requestHeaders[name] = value
    }
    let responded = false
    let trailers: IncomingHttpHeaders | null = null
    const fail = (): void => {
      if (stream.destroyed || stream.closed) return
      if (!responded) {
        stream.respond({ ':status': 502 })
        responded = true
      }
      stream.end()
    }
    const cleanup = (): void => {
      upstreamSessions.delete(upstream)
      upstream.close()
    }
    upstream.on('error', fail)
    upstream.on('close', () => upstreamSessions.delete(upstream))
    let request: ReturnType<ClientHttp2Session['request']>
    try {
      request = upstream.request(requestHeaders)
    } catch {
      fail()
      cleanup()
      return
    }
    request.on('response', (responseHeaders) => {
      if (stream.destroyed || stream.closed) return
      const response: OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(responseHeaders)) {
        if ((name === ':status' || !name.startsWith(':')) && value !== undefined) {
          response[name] = value
        }
      }
      stream.respond(response, { waitForTrailers: true })
      responded = true
      request.pipe(stream, { end: false })
    })
    request.on('trailers', (value) => {
      trailers = value
    })
    stream.on('wantTrailers', () => {
      if (stream.destroyed) return
      const forwarded: OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(trailers ?? {})) {
        if (!name.startsWith(':') && value !== undefined) forwarded[name] = value
      }
      stream.sendTrailers(forwarded)
    })
    request.on('end', () => {
      if (!stream.destroyed && !stream.closed) stream.end()
      cleanup()
    })
    request.on('error', () => {
      fail()
      cleanup()
    })
    stream.on('close', () => {
      if (!request.closed) request.close()
      cleanup()
    })
    stream.pipe(request)
  }

  return {
    ensure() {
      if (starting) return starting
      starting = new Promise<string>((resolve, rejectStart) => {
        const next = http2.createServer()
        next.on('session', (session) => {
          localSessions.add(session)
          session.once('close', () => localSessions.delete(session))
        })
        next.on('stream', forward)
        next.once('error', rejectStart)
        next.listen(0, '127.0.0.1', () => {
          next.removeListener('error', rejectStart)
          next.on('error', () => {
            for (const session of localSessions) session.destroy()
          })
          server = next
          const address = next.address()
          if (!address || typeof address === 'string') {
            rejectStart(new Error('Cursor HTTP/2 桥接地址不可用'))
            return
          }
          resolve(`http://127.0.0.1:${address.port}`)
        })
      }).catch((error) => {
        starting = null
        throw error
      })
      return starting
    },
    async close() {
      await starting?.catch(() => undefined)
      for (const session of localSessions) session.destroy()
      for (const session of upstreamSessions) session.destroy()
      if (server) {
        const current = server
        server = null
        await new Promise<void>((resolve) => current.close(() => resolve()))
      }
      starting = null
    }
  }
}
