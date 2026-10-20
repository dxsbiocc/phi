import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import test from 'node:test'
import { createWebLinkPreviewService } from '../src/main/web-link-preview'
import { rasterIconDataUrl, readHeadMetadata } from '../src/main/web-link-preview/metadata'
import {
  createPreviewFetcher,
  type PreviewResource,
  type PreviewResourceOptions,
  type RequestFactory
} from '../src/main/web-link-preview/transport'
import { checkedPreviewUrl, isPublicAddress } from '../src/main/web-link-preview/urlSafety'

const publicAddress = { address: '93.184.216.34', family: 4 as const }
const fetchOptions = (signal = new AbortController().signal): PreviewResourceOptions => ({
  signal,
  kind: 'html' as const,
  maxBytes: 262_144
})

interface ScriptedResponse {
  status?: number
  headers?: Record<string, string>
  chunks?: (string | Buffer)[]
  hang?: boolean
  interrupted?: boolean
}

function transport(
  responses: ScriptedResponse[],
  calls: { url: string; options: RequestOptions }[] = []
): RequestFactory {
  return (url, options, callback) => {
    const client = new EventEmitter()
    let destroyed = false
    Object.assign(client, {
      destroy: () => {
        destroyed = true
      },
      end: () =>
        setImmediate(() => {
          if (destroyed) return
          calls.push({ url: url.href, options })
          const script = responses.shift()
          if (!script) {
            client.emit('error', new Error('Missing scripted response'))
            return
          }
          const response = new EventEmitter()
          Object.assign(response, {
            statusCode: script.status ?? 200,
            headers: { 'content-type': 'text/html; charset=utf-8', ...script.headers },
            complete: false,
            destroy: () => {
              destroyed = true
            }
          })
          callback(response as IncomingMessage)
          for (const chunk of script.chunks ?? []) {
            if (!destroyed) response.emit('data', Buffer.from(chunk))
          }
          if (!destroyed && script.interrupted) response.emit('aborted')
          if (!destroyed && !script.hang) {
            Object.assign(response, { complete: true })
            response.emit('end')
          }
        })
    })
    return client as ClientRequest
  }
}

function png(width = 32, height = 32): Buffer {
  const result = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(result)
  result.writeUInt32BE(13, 8)
  result.write('IHDR', 12, 'ascii')
  result.writeUInt32BE(width, 16)
  result.writeUInt32BE(height, 20)
  return result
}

test('web preview accepts only bounded public HTTP(S) addresses without credentials', () => {
  for (const address of [
    '',
    ' https://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:secret@example.com',
    'http://localhost',
    'http://api.localhost',
    'http://service.local',
    'http://service.internal',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://[::1]',
    `https://example.com/${'a'.repeat(16_384)}`
  ])
    assert.throws(() => checkedPreviewUrl(address), Error, address)
  assert.throws(() => checkedPreviewUrl({ url: 'https://example.com' }))
  assert.equal(
    checkedPreviewUrl('https://example.com/path?q=1#part').href,
    'https://example.com/path?q=1#part'
  )
})

test('private, link-local, multicast and reserved IP ranges are unavailable for previews', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:5db8:d822',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '2002::1',
    '3fff::1'
  ])
    assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress('93.184.216.34'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  assert.equal(isPublicAddress('not-an-address'), false)
})

test('transport checks every DNS result and pins the validated public address for the actual request', async () => {
  const calls: { url: string; options: RequestOptions }[] = []
  const fetch = createPreviewFetcher({
    resolve: async () => [publicAddress],
    request: transport([{ chunks: ['<head><title>Page</title></head>'] }], calls)
  })
  await fetch('https://example.com/docs', fetchOptions())
  assert.equal(calls[0].url, 'https://example.com/docs')
  assert.equal(calls[0].options.agent, false)
  assert.deepEqual(calls[0].options.headers, {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Encoding': 'identity',
    'User-Agent': 'Phi-LinkPreview/1.0'
  })
  const lookup = calls[0].options.lookup!
  lookup('example.com', {}, (error, address, family) => {
    assert.equal(error, null)
    assert.equal(address, publicAddress.address)
    assert.equal(family, 4)
  })
  lookup('example.com', { all: true }, (error, addresses) => {
    assert.equal(error, null)
    assert.deepEqual(addresses, [publicAddress])
  })
  const blocked = createPreviewFetcher({
    resolve: async () => [publicAddress, { address: '10.0.0.1', family: 4 }],
    request: transport([], calls)
  })
  await assert.rejects(blocked('https://example.com', fetchOptions()), /private or reserved/)
  assert.equal(calls.length, 1)
})

test('transport validates every redirect, rejecting private and rebinding targets before a second request', async () => {
  for (const destination of ['http://127.0.0.1/secret', 'https://other.example/secret']) {
    const calls: { url: string; options: RequestOptions }[] = []
    const fetch = createPreviewFetcher({
      resolve: async (hostname) =>
        hostname === 'example.com' ? [publicAddress] : [{ address: '192.168.0.1', family: 4 }],
      request: transport([{ status: 302, headers: { location: destination } }], calls)
    })
    await assert.rejects(fetch('https://example.com', fetchOptions()), /public|private/)
    assert.equal(calls.length, 1)
  }
})

test('transport follows at most three redirects and returns the validated final URL', async () => {
  const calls: { url: string; options: RequestOptions }[] = []
  const fetch = createPreviewFetcher({
    resolve: async () => [publicAddress],
    request: transport(
      [{ status: 301, headers: { location: '/final?q=1' } }, { chunks: ['<title>Final</title>'] }],
      calls
    )
  })
  assert.equal(
    (await fetch('https://example.com/start', fetchOptions())).url,
    'https://example.com/final?q=1'
  )
  const loop = createPreviewFetcher({
    resolve: async () => [publicAddress],
    request: transport(
      Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/loop' } }))
    )
  })
  await assert.rejects(loop('https://example.com', fetchOptions()), /redirect limit/)
})

test('transport bounds body reads, stops after the real head and rejects interrupted/non-HTML content', async () => {
  const fetchScript = (script: ScriptedResponse): Promise<PreviewResource> =>
    createPreviewFetcher({ resolve: async () => [publicAddress], request: transport([script]) })(
      'https://example.com',
      fetchOptions()
    )
  const body = await fetchScript({
    chunks: [
      '<head><!-- </head> --><script>"</head>"</script><title>Safe</title></head>',
      Buffer.alloc(300_000)
    ]
  })
  assert.match(body.body.toString(), /<title>Safe<\/title>/)
  await assert.rejects(fetchScript({ chunks: [Buffer.alloc(262_145)] }), /too large/)
  await assert.rejects(
    fetchScript({ headers: { 'content-type': 'application/json' } }),
    /content type/
  )
  await assert.rejects(fetchScript({ headers: { 'content-encoding': 'gzip' } }), /content type/)
  await assert.rejects(fetchScript({ chunks: ['<head>partial'], interrupted: true }), /interrupted/)
  await assert.rejects(fetchScript({ status: 404 }), /unavailable/)
})

test('DNS resolution and slow response promises stop on abort', async () => {
  const dnsAbort = new AbortController()
  const never = createPreviewFetcher({
    resolve: () => new Promise(() => undefined),
    request: transport([])
  })('https://example.com', fetchOptions(dnsAbort.signal))
  dnsAbort.abort()
  await assert.rejects(never, /timed out/)
  const responseAbort = new AbortController()
  const slow = createPreviewFetcher({
    resolve: async () => [publicAddress],
    request: transport([{ hang: true }])
  })('https://example.com', fetchOptions(responseAbort.signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  responseAbort.abort()
  await assert.rejects(slow, /timed out/)
})

test('one-byte HTTP chunks keep progressive head scans bounded', async (context) => {
  const suffix = '<title>Tiny chunks</title></head>'
  const html = `<head>${' '.repeat(262_144 - 6 - suffix.length)}${suffix}`
  const concat = context.mock.method(Buffer, 'concat')
  const fetch = createPreviewFetcher({
    resolve: async () => [publicAddress],
    request: transport([{ chunks: Array.from(html) }])
  })

  const result = await fetch('https://example.com', fetchOptions())

  assert.equal(result.body.length, 262_144)
  assert.match(result.body.toString(), /<title>Tiny chunks<\/title><\/head>$/u)
  assert.ok(concat.mock.callCount() <= 34, `${concat.mock.callCount()} accumulated-buffer copies`)
})

test('head parser handles metadata attribute order, entities, raw elements and malformed HTML', () => {
  const result = readHeadMetadata(`<head>
    <!-- <meta property="og:title" content="Comment"> -->
    <script>"<meta property='og:title' content='Script'>"</script>
    <style>.a:after { content: '<meta name="description" content="Style">'; }</style>
    <title>Fallback &amp; title</title>
    <meta content='Study &#x26; Results &amp;lt;' PROPERTY='og:title'>
    <meta name=description content="Fallback description">
    <meta content="Better &quot;description&quot; &#160; content" property=og:description>
    <meta property=og:site_name content="Scientific Site">
    <link href="/icon.png?a=1&amp;b=2" rel="shortcut icon">
    </head><meta property="og:title" content="Body">`)
  assert.equal(result.title, 'Study & Results &lt;')
  assert.equal(result.description, 'Better "description" content')
  assert.equal(result.siteName, 'Scientific Site')
  assert.deepEqual(result.icons, ['/icon.png?a=1&b=2'])
  assert.notEqual(result.end, null)
  assert.equal(readHeadMetadata('<title>Unfinished').title, null)
  assert.equal(readHeadMetadata('<head><meta name=description content="broken').description, null)
  assert.equal(readHeadMetadata('<title>Plain &amp; Safe</title>').title, 'Plain & Safe')
  assert.equal(
    readHeadMetadata('<meta property="og:title" content="  "><title>Fallback</title>').title,
    'Fallback'
  )
  assert.equal(readHeadMetadata('<div><meta property="og:title" content="Body">').title, null)
  assert.equal(
    readHeadMetadata(
      '<meta name=twitter:title content=Twitter><meta name=twitter:description content=Summary>'
    ).title,
    'Twitter'
  )
})

test('metadata is bounded text and unsupported or oversized icons are rejected', () => {
  const data = readHeadMetadata(
    `<title>${'a'.repeat(800)}</title><meta name=description content="${'b'.repeat(2000)}">`
  )
  assert.equal(data.title?.length, 512)
  assert.equal(data.description?.length, 1024)
  assert.match(rasterIconDataUrl(png(), 'image/png') ?? '', /^data:image\/png;base64,/)
  assert.equal(rasterIconDataUrl(png(8192, 8192), 'image/png'), null)
  assert.equal(rasterIconDataUrl(png(), 'text/html'), null)
  assert.equal(
    rasterIconDataUrl(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/svg+xml'),
    null
  )
  assert.equal(rasterIconDataUrl(Buffer.alloc(65_537), 'image/png'), null)
  const icon = Buffer.alloc(22 + png().length)
  icon.writeUInt16LE(1, 2)
  icon.writeUInt16LE(1, 4)
  icon[6] = 32
  icon[7] = 32
  icon.writeUInt32LE(png().length, 14)
  icon.writeUInt32LE(22, 18)
  png().copy(icon, 22)
  assert.match(
    rasterIconDataUrl(icon, 'image/vnd.microsoft.icon') ?? '',
    /^data:image\/x-icon;base64,/
  )
  icon.fill(0, 22)
  assert.equal(rasterIconDataUrl(icon, 'image/x-icon'), null)
})

test('preview service deduplicates and caches by address without replacing each original query/fragment', async () => {
  let now = 1000
  const calls: string[] = []
  const service = createWebLinkPreviewService({
    now: () => now,
    fetch: async (url, { kind }) => {
      calls.push(url)
      return kind === 'html'
        ? {
            url: 'https://example.com/final?q=1',
            contentType: 'text/html',
            body: Buffer.from(
              '<title>Title</title><meta name=description content="Description"><link rel=icon href=/icon.png>'
            )
          }
        : { url, contentType: 'image/png', body: png() }
    }
  })
  const [one, two] = await Promise.all([
    service.get('https://example.com/start?q=1#one'),
    service.get('https://example.com/start?q=1#two')
  ])
  assert.equal(one.url, 'https://example.com/start?q=1#one')
  assert.equal(two.url, 'https://example.com/start?q=1#two')
  assert.equal(two.resolvedUrl, 'https://example.com/final?q=1')
  assert.equal(two.title, 'Title')
  assert.equal(calls.length, 2)
  const cached = await service.get('https://example.com/start?q=1#three')
  assert.equal(cached.url, 'https://example.com/start?q=1#three')
  assert.equal(calls.length, 2)
  now += 600_001
  await service.get('https://example.com/start?q=1#four')
  assert.equal(calls.length, 4)
  await service.get('https://example.com/start?q=2')
  assert.equal(calls.length, 6)
})

test('service enforces bounded cache, failure TTL, concurrency and overall timeout', async () => {
  let calls = 0
  let now = 100
  const unavailable = createWebLinkPreviewService({
    cacheEntries: 1,
    now: () => now,
    fetch: async () => {
      calls++
      throw new Error('Unavailable')
    }
  })
  assert.equal((await unavailable.get('https://example.com/a')).title, null)
  await unavailable.get('https://example.com/a#cached')
  assert.equal(calls, 1)
  now += 30_001
  await unavailable.get('https://example.com/a')
  assert.equal(calls, 2)
  await unavailable.get('https://example.com/b')
  await unavailable.get('https://example.com/a')
  assert.equal(calls, 4)
  const slow = createWebLinkPreviewService({
    timeoutMs: 20,
    concurrency: 1,
    fetch: () => new Promise(() => undefined)
  })
  const first = slow.get('https://example.com/a')
  const second = await slow.get('https://example.com/b#original')
  assert.equal(second.url, 'https://example.com/b#original')
  assert.equal(second.title, null)
  assert.equal((await first).title, null)
})

test('favicon destinations get the same redirect/DNS restrictions and failures retain page metadata', async () => {
  const calls: { url: string; options: RequestOptions }[] = []
  const service = createWebLinkPreviewService({
    fetch: createPreviewFetcher({
      resolve: async (hostname) =>
        hostname === 'example.com' ? [publicAddress] : [{ address: '10.0.0.1', family: 4 }],
      request: transport(
        [
          {
            chunks: [
              '<title>Safe page</title><link rel=icon href="https://blocked.example/icon.png">'
            ]
          },
          { status: 302, headers: { location: 'http://169.254.169.254/icon' } }
        ],
        calls
      )
    })
  })
  const result = await service.get('https://example.com/#original')
  assert.equal(result.title, 'Safe page')
  assert.equal(result.iconDataUrl, null)
  assert.deepEqual(
    calls.map(({ url }) => url),
    ['https://example.com/', 'https://example.com/favicon.ico']
  )
})

test('preview IPC checks the trusted main renderer and exposes only the typed preload method', () => {
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  assert.match(
    main,
    /ipcMain\.handle\(IPC\.webLink\.preview, \(event, url: unknown\) => \{\s*requireMainWindowRenderer\(event\)\s*return webLinkPreviews\.get\(url\)/u
  )
  assert.match(preload, /getWebLinkPreview: \(url: string\) => Promise<WebLinkPreview>/u)
  assert.match(
    preload,
    /getWebLinkPreview: \(url: string\): Promise<WebLinkPreview> =>\s*ipcRenderer\.invoke\(IPC\.webLink\.preview, url\)/u
  )
})
