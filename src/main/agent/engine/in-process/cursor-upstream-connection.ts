import http2, { type ClientHttp2Session } from 'node:http2'
import net from 'node:net'
import tls from 'node:tls'

const TUNNEL_TIMEOUT_MS = 30_000
const MAX_CONNECT_RESPONSE_BYTES = 16 * 1024

type ProxyEnv = Readonly<Record<string, string | undefined>>

function bypassesProxy(host: string, env: ProxyEnv): boolean {
  if (host === 'localhost' || host === '[::1]' || host.startsWith('127.')) return true
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? ''
  return noProxy
    .split(',')
    .map((entry) =>
      entry
        .trim()
        .toLowerCase()
        .replace(/^\*?\./, '')
    )
    .some((entry) => entry === '*' || (entry && (host === entry || host.endsWith(`.${entry}`))))
}

/**
 * Same environment the local Cursor provider honours. Only HTTP(S) CONNECT proxies are tunnelled;
 * other schemes stay direct, as they did before this existed.
 */
export function cursorProxyFor(origin: string, env: ProxyEnv = process.env): URL | undefined {
  const target = new URL(origin)
  if (target.protocol !== 'https:' || bypassesProxy(target.hostname.toLowerCase(), env)) {
    return undefined
  }
  const value =
    env.PI_PROXY_CURSOR ??
    env.PI_PROXY ??
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.ALL_PROXY ??
    env.all_proxy
  if (!value) return undefined
  try {
    const proxy = new URL(value)
    return proxy.protocol === 'http:' || proxy.protocol === 'https:' ? proxy : undefined
  } catch {
    return undefined
  }
}

function connectToProxy(proxy: URL): net.Socket {
  const port = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)
  return proxy.protocol === 'https:'
    ? tls.connect({ host: proxy.hostname, port, servername: proxy.hostname })
    : net.connect({ host: proxy.hostname, port })
}

function connectRequest(proxy: URL, authority: string): string {
  const credentials = proxy.username
    ? Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      ).toString('base64')
    : undefined
  return [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    ...(credentials ? [`Proxy-Authorization: Basic ${credentials}`] : []),
    '',
    ''
  ].join('\r\n')
}

/** Resolves once the proxy accepted CONNECT. Bytes after the headers belong to the tunnel. */
export function openProxyTunnel(proxy: URL, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectToProxy(proxy)
    let received = Buffer.alloc(0)
    const fail = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    const onError = (): void => fail(new Error('Cursor proxy connection failed'))
    const onClose = (): void => fail(new Error('Cursor proxy closed the tunnel'))
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf('\r\n\r\n')
      if (end < 0) {
        if (received.length > MAX_CONNECT_RESPONSE_BYTES)
          fail(new Error('Cursor proxy reply too large'))
        return
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(
        received.subarray(0, end).toString('latin1')
      )?.[1]
      if (status !== '200') {
        fail(new Error(`Cursor proxy refused the tunnel (${status ?? 'invalid reply'})`))
        return
      }
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.setTimeout(0)
      // Stop flowing first, or bytes put back below would be emitted before the caller listens.
      socket.pause()
      const rest = received.subarray(end + 4)
      if (rest.length) socket.unshift(rest)
      resolve(socket)
    }
    socket.setTimeout(TUNNEL_TIMEOUT_MS, () => fail(new Error('Cursor proxy tunnel timed out')))
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.write(connectRequest(proxy, `${host}:${port}`))
  })
}

function upgradeToH2(socket: net.Socket, servername: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername, ALPNProtocols: ['h2'] })
    secured.setTimeout(TUNNEL_TIMEOUT_MS, () => secured.destroy(new Error('Cursor TLS timed out')))
    secured.once('error', reject)
    secured.once('secureConnect', () => {
      secured.off('error', reject)
      secured.setTimeout(0)
      resolve(secured)
    })
  })
}

/** The worker's direct route and this gateway must leave through the same network path. */
export async function connectCursorUpstream(origin: string): Promise<ClientHttp2Session> {
  const proxy = cursorProxyFor(origin)
  if (!proxy) return http2.connect(origin)
  const target = new URL(origin)
  const tunnel = await openProxyTunnel(proxy, target.hostname, Number(target.port) || 443)
  const secured = await upgradeToH2(tunnel, target.hostname)
  return http2.connect(origin, { createConnection: () => secured })
}
