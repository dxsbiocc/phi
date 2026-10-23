import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureCachedRemoteOmp } from '../src/main/agent/engine/rpc/runtime-deployment/artifact-cache'
import type { RemoteOmpFailureDetail } from '../src/shared/errorCodes'

type RemoteOmpFailure = Error & {
  code?: string
  errorDetail?: RemoteOmpFailureDetail
}

const payload = Buffer.from('resumable-omp-fixture\n'.repeat(512))
const sha256 = createHash('sha256').update(payload).digest('hex')

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/omp-linux-x64`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

test('a dropped response keeps its verified partial and resumes with Range', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const ranges: Array<string | undefined> = []
  const server = await listen((request, response) => {
    requests++
    ranges.push(request.headers.range)
    const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0)
    response.setHeader('accept-ranges', 'bytes')
    response.setHeader('etag', '"fixture-v1"')
    if (offset > 0) {
      response.writeHead(206, {
        'content-length': payload.length - offset,
        'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`
      })
      response.end(payload.subarray(offset))
      return
    }
    response.writeHead(200, { 'content-length': payload.length })
    response.write(payload.subarray(0, 2048))
    setTimeout(() => response.destroy(), 10)
  })
  t.after(server.close)

  const progress: Array<{ bytesReceived: number; totalBytes?: number; attempt: number }> = []
  const cached = await ensureCachedRemoteOmp({
    cacheDir: root,
    version: '1.2.3',
    platform: 'linux-x64',
    asset: { url: server.url, sha256, size: payload.length },
    maxAttempts: 3,
    retryDelayMs: 1,
    inactivityTimeoutMs: 100,
    onProgress: (event) => progress.push(event)
  })

  assert.deepEqual(await readFile(cached.localPath), payload)
  assert.equal(requests, 2)
  assert.equal(ranges[0], undefined)
  assert.match(ranges[1] ?? '', /^bytes=[1-9]\d*-$/)
  assert.ok(progress.some((event) => event.attempt === 2 && event.bytesReceived > 2048))
  assert.deepEqual(await readdir(join(root, 'omp', '1.2.3', 'linux-x64')), ['omp'])
})

test('an inactive response is aborted and resumed on the next bounded attempt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-stall-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const server = await listen((request, response) => {
    requests++
    const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0)
    response.setHeader('etag', '"fixture-v1"')
    if (requests === 1) {
      response.writeHead(200, { 'content-length': payload.length })
      response.write(payload.subarray(0, 1024))
      return
    }
    response.writeHead(206, {
      'content-length': payload.length - offset,
      'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`
    })
    response.end(payload.subarray(offset))
  })
  t.after(server.close)

  const cached = await ensureCachedRemoteOmp({
    cacheDir: root,
    version: '1.2.3',
    platform: 'linux-x64',
    asset: { url: server.url, sha256, size: payload.length },
    maxAttempts: 2,
    retryDelayMs: 1,
    inactivityTimeoutMs: 20
  })

  assert.deepEqual(await readFile(cached.localPath), payload)
  assert.equal(requests, 2)
})

test('a server that ignores Range restarts the partial without regressing progress', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-ignore-range-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const ranges: Array<string | undefined> = []
  const server = await listen((request, response) => {
    requests++
    ranges.push(request.headers.range)
    response.setHeader('etag', '"fixture-v1"')
    response.writeHead(200, { 'content-length': payload.length })
    if (requests === 1) {
      response.write(payload.subarray(0, 1536))
      setTimeout(() => response.destroy(), 10)
      return
    }
    response.end(payload)
  })
  t.after(server.close)
  const progress: Array<{ bytesReceived: number; totalBytes?: number; attempt: number }> = []

  const cached = await ensureCachedRemoteOmp({
    cacheDir: root,
    version: '1.2.3',
    platform: 'linux-x64',
    asset: { url: server.url, sha256, size: payload.length },
    maxAttempts: 2,
    retryDelayMs: 1,
    inactivityTimeoutMs: 100,
    onProgress: (event) => progress.push(event)
  })

  assert.deepEqual(await readFile(cached.localPath), payload)
  assert.match(ranges[1] ?? '', /^bytes=[1-9]\d*-$/)
  assert.ok(
    progress.every(
      (event, index) => index === 0 || event.bytesReceived >= progress[index - 1].bytesReceived
    )
  )
})

test('HTTP 416 discards stale partial state and restarts from byte zero', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-416-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ranges: Array<string | undefined> = []
  const server = await listen((request, response) => {
    ranges.push(request.headers.range)
    if (ranges.length === 1) {
      response.writeHead(200, { 'content-length': payload.length, etag: '"fixture-v1"' })
      response.write(payload.subarray(0, 1024))
      setTimeout(() => response.destroy(), 10)
      return
    }
    if (ranges.length === 2) {
      response.writeHead(416, { 'content-range': `bytes */${payload.length}` })
      response.end()
      return
    }
    response.writeHead(200, { 'content-length': payload.length, etag: '"fixture-v1"' })
    response.end(payload)
  })
  t.after(server.close)

  const cached = await ensureCachedRemoteOmp({
    cacheDir: root,
    version: '1.2.3',
    platform: 'linux-x64',
    asset: { url: server.url, sha256, size: payload.length },
    maxAttempts: 2,
    retryDelayMs: 1,
    inactivityTimeoutMs: 100
  })

  assert.deepEqual(await readFile(cached.localPath), payload)
  assert.equal(ranges.length, 3)
  assert.match(ranges[1] ?? '', /^bytes=[1-9]\d*-$/)
  assert.equal(ranges[2], undefined)
})

test('an ETag change rejects resumed bytes and restarts with the new representation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-etag-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ranges: Array<string | undefined> = []
  const ifRanges: Array<string | undefined> = []
  const server = await listen((request, response) => {
    ranges.push(request.headers.range)
    const ifRange = request.headers['if-range']
    ifRanges.push(Array.isArray(ifRange) ? ifRange[0] : ifRange)
    if (ranges.length === 1) {
      response.writeHead(200, { 'content-length': payload.length, etag: '"fixture-v1"' })
      response.write(payload.subarray(0, 1024))
      setTimeout(() => response.destroy(), 10)
      return
    }
    if (ranges.length === 2) {
      const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0)
      response.writeHead(206, {
        'content-length': payload.length - offset,
        'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
        etag: '"fixture-v2"'
      })
      response.end(payload.subarray(offset))
      return
    }
    response.writeHead(200, { 'content-length': payload.length, etag: '"fixture-v2"' })
    response.end(payload)
  })
  t.after(server.close)

  const cached = await ensureCachedRemoteOmp({
    cacheDir: root,
    version: '1.2.3',
    platform: 'linux-x64',
    asset: { url: server.url, sha256, size: payload.length },
    maxAttempts: 2,
    retryDelayMs: 1,
    inactivityTimeoutMs: 100
  })

  assert.deepEqual(await readFile(cached.localPath), payload)
  assert.equal(ifRanges[1], '"fixture-v1"')
  assert.equal(ranges[2], undefined)
})

test('a checksum mismatch deletes resumable state and points to preseed guidance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-checksum-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const corrupt = Buffer.from(payload)
  corrupt[0] ^= 0xff
  const server = await listen((_request, response) => {
    response.writeHead(200, { 'content-length': corrupt.length, etag: '"corrupt"' })
    response.end(corrupt)
  })
  t.after(server.close)

  await assert.rejects(
    ensureCachedRemoteOmp({
      cacheDir: root,
      version: '1.2.3',
      platform: 'linux-x64',
      asset: { url: server.url, sha256, size: payload.length },
      maxAttempts: 1,
      retryDelayMs: 0,
      inactivityTimeoutMs: 100
    }),
    (error: RemoteOmpFailure) => {
      assert.equal(error.code, 'HASH_MISMATCH')
      assert.deepEqual(error.errorDetail, { cause: 'checksum' })
      assert.match(error.message, /checksum/i)
      assert.match(error.message, /docs\/runtime\/remote-omp-preseed\.md/)
      return true
    }
  )
  assert.deepEqual(await readdir(join(root, 'omp', '1.2.3', 'linux-x64')), [])
})

test('caller abort returns immediately, retains the partial, and a later call resumes it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-abort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const server = await listen((request, response) => {
    requests++
    const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0)
    response.setHeader('etag', '"fixture-v1"')
    if (requests === 1) {
      response.writeHead(200, { 'content-length': payload.length })
      response.write(payload.subarray(0, 1024))
      return
    }
    response.writeHead(206, {
      'content-length': payload.length - offset,
      'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`
    })
    response.end(payload.subarray(offset))
  })
  t.after(server.close)
  const controller = new AbortController()
  const options = {
    cacheDir: root,
    version: '1.2.3',
    platform: 'linux-x64',
    asset: { url: server.url, sha256, size: payload.length },
    maxAttempts: 2,
    retryDelayMs: 1,
    inactivityTimeoutMs: 1_000
  }

  await assert.rejects(
    ensureCachedRemoteOmp({
      ...options,
      signal: controller.signal,
      onProgress: ({ bytesReceived }) => {
        if (bytesReceived > 0) controller.abort()
      }
    }),
    { name: 'AbortError' }
  )
  const directory = join(root, 'omp', '1.2.3', 'linux-x64')
  assert.deepEqual((await readdir(directory)).sort(), ['omp.partial', 'omp.partial.json'])
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'omp.partial.json'), 'utf8')), {
    schema: 1,
    url: server.url,
    sha256,
    expectedSize: payload.length,
    etag: '"fixture-v1"'
  })

  const cached = await ensureCachedRemoteOmp(options)
  assert.deepEqual(await readFile(cached.localPath), payload)
  assert.equal(requests, 2)
})

test('concurrent callers share one artifact write and cache hits make no request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-concurrent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const server = await listen((_request, response) => {
    requests++
    response.writeHead(200, {
      'content-length': payload.length,
      etag: '"fixture-v1"'
    })
    response.end(payload)
  })
  t.after(server.close)
  const options = {
    cacheDir: root,
    version: '1.2.3',
    platform: 'linux-x64',
    asset: { url: server.url, sha256, size: payload.length },
    maxAttempts: 1,
    retryDelayMs: 0,
    inactivityTimeoutMs: 100
  }

  const [first, second] = await Promise.all([
    ensureCachedRemoteOmp(options),
    ensureCachedRemoteOmp(options)
  ])
  assert.equal(first.localPath, second.localPath)
  assert.equal(requests, 1)
  await ensureCachedRemoteOmp({
    ...options,
    fetchImpl: async () => {
      throw new Error('cache hit must not make a request')
    }
  })
  assert.equal(requests, 1)
})

test('HTTP failure after bounded retries names the status and preseed recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-http-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const server = await listen((_request, response) => {
    requests++
    response.writeHead(503)
    response.end()
  })
  t.after(server.close)

  await assert.rejects(
    ensureCachedRemoteOmp({
      cacheDir: root,
      version: '1.2.3',
      platform: 'linux-x64',
      asset: { url: server.url, sha256, size: payload.length },
      maxAttempts: 2,
      retryDelayMs: 1,
      inactivityTimeoutMs: 100
    }),
    (error: RemoteOmpFailure) => {
      assert.equal(error.code, 'DOWNLOAD_FAILED')
      assert.deepEqual(error.errorDetail, { cause: 'http', httpStatus: 503, attempts: 2 })
      assert.match(error.message, /HTTP 503/)
      assert.match(error.message, /2 attempts/)
      assert.match(error.message, /docs\/runtime\/remote-omp-preseed\.md/)
      assert.doesNotMatch(error.message, /\n\s+at /)
      return true
    }
  )
  assert.equal(requests, 2)
})

test('terminal inactivity names the network stall and retains resumable state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-terminal-stall-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = await listen((_request, response) => {
    response.writeHead(200, { 'content-length': payload.length, etag: '"fixture-v1"' })
    response.write(payload.subarray(0, 512))
  })
  t.after(server.close)

  await assert.rejects(
    ensureCachedRemoteOmp({
      cacheDir: root,
      version: '1.2.3',
      platform: 'linux-x64',
      asset: { url: server.url, sha256, size: payload.length },
      maxAttempts: 1,
      retryDelayMs: 0,
      inactivityTimeoutMs: 20
    }),
    (error: RemoteOmpFailure) => {
      assert.equal(error.code, 'DOWNLOAD_FAILED')
      assert.deepEqual(error.errorDetail, { cause: 'stall', stallMs: 20, attempts: 1 })
      assert.match(error.message, /network stalled/i)
      assert.match(error.message, /docs\/runtime\/remote-omp-preseed\.md/)
      return true
    }
  )
  assert.deepEqual((await readdir(join(root, 'omp', '1.2.3', 'linux-x64'))).sort(), [
    'omp.partial',
    'omp.partial.json'
  ])
})

test('network and invalid response failures retain structured causes after retries', async (t) => {
  const networkRoot = await mkdtemp(join(tmpdir(), 'phi-omp-cache-network-'))
  const responseRoot = await mkdtemp(join(tmpdir(), 'phi-omp-cache-response-'))
  t.after(async () => {
    await Promise.all([networkRoot, responseRoot].map((root) => rm(root, { recursive: true })))
  })

  await assert.rejects(
    ensureCachedRemoteOmp({
      cacheDir: networkRoot,
      version: '1.2.3',
      platform: 'linux-x64',
      asset: { url: 'https://example.invalid/omp', sha256, size: payload.length },
      maxAttempts: 2,
      retryDelayMs: 0,
      inactivityTimeoutMs: 100,
      fetchImpl: async () => {
        throw new Error('socket closed')
      }
    }),
    (error: RemoteOmpFailure) => {
      assert.deepEqual(error.errorDetail, { cause: 'network', attempts: 2 })
      return true
    }
  )

  await assert.rejects(
    ensureCachedRemoteOmp({
      cacheDir: responseRoot,
      version: '1.2.3',
      platform: 'linux-x64',
      asset: {
        url: 'https://example.invalid/omp',
        sha256,
        size: payload.length - 1
      },
      maxAttempts: 1,
      retryDelayMs: 0,
      inactivityTimeoutMs: 100,
      fetchImpl: async () => new Response(payload, { status: 200 })
    }),
    (error: RemoteOmpFailure) => {
      assert.deepEqual(error.errorDetail, { cause: 'invalid_response', attempts: 1 })
      return true
    }
  )
})

test('partial files reject symlink and hardlink substitution without touching their targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-omp-cache-partial-safety-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = await listen((_request, response) => {
    response.writeHead(200, { 'content-length': payload.length, etag: '"fixture-v1"' })
    response.write(payload.subarray(0, 512))
  })
  t.after(server.close)
  const options = {
    cacheDir: root,
    version: '1.2.3',
    platform: 'linux-x64',
    asset: { url: server.url, sha256, size: payload.length },
    maxAttempts: 1,
    retryDelayMs: 0,
    inactivityTimeoutMs: 20
  }
  await assert.rejects(ensureCachedRemoteOmp(options), { code: 'DOWNLOAD_FAILED' })
  const directory = join(root, 'omp', '1.2.3', 'linux-x64')
  const partial = join(directory, 'omp.partial')
  const outside = join(root, 'outside')
  await writeFile(outside, 'must remain unchanged')

  await rm(partial)
  await symlink(outside, partial)
  await assert.rejects(ensureCachedRemoteOmp(options), { code: 'PERMISSION_DENIED' })
  assert.equal(await readFile(outside, 'utf8'), 'must remain unchanged')

  await rm(partial)
  await link(outside, partial)
  await assert.rejects(ensureCachedRemoteOmp(options), { code: 'PERMISSION_DENIED' })
  assert.equal(await readFile(outside, 'utf8'), 'must remain unchanged')
})
