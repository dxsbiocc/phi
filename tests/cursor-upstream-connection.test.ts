import assert from 'node:assert/strict'
import net from 'node:net'
import { it } from 'node:test'

import {
  cursorProxyFor,
  openProxyTunnel
} from '../src/main/agent/engine/in-process/cursor-upstream-connection'

const CURSOR = 'https://api2.cursor.sh'

it('uses the same proxy settings as the local Cursor route', () => {
  assert.equal(cursorProxyFor(CURSOR, {}), undefined)
  assert.equal(
    cursorProxyFor(CURSOR, { HTTPS_PROXY: 'http://127.0.0.1:9981' })?.href,
    'http://127.0.0.1:9981/'
  )
  assert.equal(
    cursorProxyFor(CURSOR, { HTTPS_PROXY: 'http://a:1', PI_PROXY_CURSOR: 'http://b:2' })?.hostname,
    'b'
  )
  assert.equal(cursorProxyFor(CURSOR, { ALL_PROXY: 'socks5://127.0.0.1:1080' }), undefined)
  assert.equal(cursorProxyFor(CURSOR, { HTTPS_PROXY: 'not a url' }), undefined)
})

it('stays direct for bypassed hosts and the loopback test upstream', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:9981' }
  assert.equal(cursorProxyFor('http://127.0.0.1:4000', env), undefined)
  assert.equal(cursorProxyFor('https://127.0.0.1:4000', env), undefined)
  assert.equal(cursorProxyFor(CURSOR, { ...env, NO_PROXY: 'localhost,.cursor.sh' }), undefined)
  assert.equal(cursorProxyFor(CURSOR, { ...env, NO_PROXY: '*' }), undefined)
  assert.ok(cursorProxyFor(CURSOR, { ...env, NO_PROXY: 'localhost,example.com' }))
})

async function fakeProxy(
  reply: string,
  after = ''
): Promise<{ url: URL; seen: Promise<string>; close(): void }> {
  let report: (value: string) => void = () => undefined
  const seen = new Promise<string>((resolve) => {
    report = resolve
  })
  const server = net.createServer((socket) => {
    socket.once('data', (data) => {
      report(data.toString('latin1'))
      socket.write(`${reply}\r\n\r\n${after}`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  return { url: new URL(`http://u%40x:p@127.0.0.1:${port}`), seen, close: () => server.close() }
}

it('opens a CONNECT tunnel and keeps bytes that arrived with the reply', async (t) => {
  const proxy = await fakeProxy('HTTP/1.1 200 Connection established', 'early')
  t.after(proxy.close)
  const socket = await openProxyTunnel(proxy.url, 'api2.cursor.sh', 443)
  t.after(() => socket.destroy())
  const request = await proxy.seen
  assert.match(request, /^CONNECT api2\.cursor\.sh:443 HTTP\/1\.1\r\n/)
  assert.match(
    request,
    new RegExp(`Proxy-Authorization: Basic ${Buffer.from('u@x:p').toString('base64')}`)
  )
  const first = await new Promise<Buffer>((resolve) => {
    socket.once('data', resolve)
    socket.resume()
  })
  assert.equal(first.toString(), 'early')
})

it('reports a refused tunnel instead of falling back to a direct connection', async (t) => {
  const proxy = await fakeProxy('HTTP/1.1 403 Forbidden')
  t.after(proxy.close)
  await assert.rejects(
    openProxyTunnel(proxy.url, 'api2.cursor.sh', 443),
    /refused the tunnel \(403\)/
  )
})
