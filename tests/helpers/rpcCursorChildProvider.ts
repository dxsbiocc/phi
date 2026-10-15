import http2, { type ServerHttp2Stream } from 'node:http2'
import { startLoopbackCursor } from './loopbackCursor'

/** Keep the first two real Cursor EOFs behind one barrier so child recoveries overlap. */
export async function startCursorChildProvider(
  parallel: boolean
): ReturnType<typeof startLoopbackCursor> {
  const provider = await startLoopbackCursor()
  if (!parallel) return provider
  const upstream = http2.connect(provider.url)
  const clients = new Set<http2.ServerHttp2Session>()
  const held: ServerHttp2Stream[] = []
  let count = 0
  const server = http2.createServer()
  server.on('session', (session) => {
    clients.add(session)
    session.once('close', () => clients.delete(session))
  })
  upstream.on('error', () => undefined)
  server.on('stream', (stream, headers) => {
    const ordinal = ++count
    const request = upstream.request(headers)
    request.on('response', (response) => {
      stream.respond({
        ':status': response[':status'] ?? 500,
        'content-type': 'application/connect+proto'
      })
    })
    request.on('data', (chunk: Buffer) => {
      if (!stream.destroyed) stream.write(chunk)
    })
    request.on('end', () => {
      if (ordinal > 2) {
        stream.end()
        return
      }
      held.push(stream)
      if (held.length === 2) for (const ready of held.splice(0)) if (!ready.destroyed) ready.end()
    })
    stream.pipe(request)
    stream.on('close', () => request.close())
    stream.on('error', () => request.close())
    request.on('error', () => stream.close())
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      const results = await Promise.allSettled([
        ...[...clients].map((client) => Promise.resolve().then(() => client.destroy())),
        Promise.resolve().then(() => upstream.destroy()),
        Promise.resolve().then(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        Promise.resolve().then(() => provider.close())
      ])
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })())
  let port: number
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No Cursor barrier port')
    port = address.port
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
  return {
    ...provider,
    url: `http://127.0.0.1:${port}`,
    close
  }
}
