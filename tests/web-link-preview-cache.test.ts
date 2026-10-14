import assert from 'node:assert/strict'
import test from 'node:test'
import type { WebLinkPreview } from '../src/shared/webLinkPreviewTypes'
import { createWebLinkPreviewCache } from '../src/renderer/src/lib/webLinkPreviewCache'

function previewFor(url: string): WebLinkPreview {
  return {
    url,
    resolvedUrl: url,
    title: 'Project documentation',
    description: 'Installation and usage instructions.',
    siteName: 'Example',
    iconDataUrl: null
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

test('preview cache shares one pending request for the same URL', async () => {
  const url = 'https://example.com/docs'
  const response = deferred<WebLinkPreview | null>()
  let reads = 0
  const cache = createWebLinkPreviewCache(async () => {
    reads += 1
    return response.promise
  })

  const first = cache.read(url)
  const second = cache.read(url)
  await Promise.resolve()

  assert.equal(first, second)
  assert.equal(reads, 1)
  assert.equal(cache.peek(url), undefined)
  response.resolve(previewFor(url))
  assert.deepEqual(await first, previewFor(url))
})

test('successful previews remain cached until their success TTL expires', async () => {
  const url = 'https://example.com/docs'
  let now = 0
  let reads = 0
  const cache = createWebLinkPreviewCache(
    async () => {
      reads += 1
      return previewFor(url)
    },
    { now: () => now, ttlMs: 100, failureTtlMs: 10 }
  )

  await cache.read(url)
  now = 99
  assert.deepEqual(await cache.read(url), previewFor(url))
  assert.equal(reads, 1)

  now = 100
  assert.equal(cache.peek(url), undefined)
  await cache.read(url)
  assert.equal(reads, 2)
})

test('unavailable previews are retried after the shorter failure TTL', async () => {
  const url = 'https://example.com/unavailable'
  let now = 0
  let reads = 0
  const cache = createWebLinkPreviewCache(
    async () => {
      reads += 1
      return null
    },
    { now: () => now, ttlMs: 100, failureTtlMs: 10 }
  )

  assert.equal(await cache.read(url), null)
  now = 9
  assert.equal(await cache.read(url), null)
  assert.equal(reads, 1)

  now = 10
  assert.equal(cache.peek(url), undefined)
  await cache.read(url)
  assert.equal(reads, 2)
})

test('rejected preview requests become a cached fallback with a short retry TTL', async () => {
  const url = 'https://example.com/offline'
  let now = 0
  let reads = 0
  const cache = createWebLinkPreviewCache(
    async () => {
      reads += 1
      throw new Error('network unavailable')
    },
    { now: () => now, failureTtlMs: 10 }
  )

  assert.equal(await cache.read(url), null)
  assert.equal(await cache.read(url), null)
  assert.equal(reads, 1)

  now = 10
  assert.equal(await cache.read(url), null)
  assert.equal(reads, 2)
})

test('preview cache evicts the least recently used entry at capacity', async () => {
  const cache = createWebLinkPreviewCache(async (url) => previewFor(url), { capacity: 2 })
  const first = 'https://example.com/first'
  const second = 'https://example.com/second'
  const third = 'https://example.com/third'

  await cache.read(first)
  await cache.read(second)
  assert.deepEqual(cache.peek(first), previewFor(first))
  await cache.read(third)

  assert.equal(cache.peek(second), undefined)
  assert.deepEqual(cache.peek(first), previewFor(first))
  assert.deepEqual(cache.peek(third), previewFor(third))
})

test('preview cache limits requests to eight concurrent URLs and retries once a slot is free', async () => {
  const responses = new Map<string, ReturnType<typeof deferred<WebLinkPreview | null>>>()
  const cache = createWebLinkPreviewCache(async (url) => {
    const response = deferred<WebLinkPreview | null>()
    responses.set(url, response)
    return response.promise
  })
  const urls = Array.from({ length: 9 }, (_, index) => `https://example.com/${index}`)
  const requests = urls.slice(0, 8).map((url) => cache.read(url))
  await Promise.resolve()

  assert.equal(responses.size, 8)
  assert.equal(await cache.read(urls[8]), null)
  assert.equal(cache.peek(urls[8]), undefined)
  responses.get(urls[0])!.resolve(previewFor(urls[0]))
  await requests[0]

  const retry = cache.read(urls[8])
  await Promise.resolve()
  assert.equal(responses.size, 9)
  for (const [url, response] of responses) response.resolve(previewFor(url))
  await Promise.all([...requests, retry])
  assert.deepEqual(cache.peek(urls[8]), previewFor(urls[8]))
})
