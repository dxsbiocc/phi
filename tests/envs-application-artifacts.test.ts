import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  cacheVerifiedArtifact,
  fetchArtifact,
  installationSpecSha256,
  readVerifiedArtifact,
  readVerifiedInstallationAsset
} from '../src/main/agent/envs/applications/artifacts'

const bytes = Buffer.from('verified application bytes')
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const pin = { url: 'https://example.test/application', sha256: sha256(bytes), size: bytes.length }

async function withRoot(body: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-application-artifact-'))
  try {
    await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function responseFetch(data = bytes): typeof fetch {
  return (async () => new Response(data)) as typeof fetch
}

test('artifact cache verifies downloaded bytes and reuses them offline', async () => {
  await withRoot(async (root) => {
    const result = await fetchArtifact(root, pin, { fetch: responseFetch() })
    assert.deepEqual(result, {
      path: join(root, 'artifacts', `sha256-${pin.sha256}`),
      key: `sha256-${pin.sha256}`,
      sha256: pin.sha256,
      size: bytes.length
    })
    assert.deepEqual(readFileSync(result.path), bytes)
    const again = await fetchArtifact(root, pin, {
      fetch: (async () => {
        throw new Error('offline')
      }) as typeof fetch
    })
    assert.deepEqual(again, result)
    assert.deepEqual(readdirSync(join(root, 'artifacts')), [result.key])
  })
})

test('artifact cache supports npm SHA512 SRI and records the content SHA256', async () => {
  await withRoot(async (root) => {
    const sha512 = createHash('sha512').update(bytes)
    const digest = sha512.digest()
    const result = await fetchArtifact(
      root,
      { url: pin.url, integrity: `sha512-${digest.toString('base64')}` },
      { fetch: responseFetch() }
    )
    assert.equal(result.key, `sha512-${digest.toString('hex')}`)
    assert.equal(result.sha256, pin.sha256)
    assert.equal(result.size, bytes.length)
  })
})

test('signed installer snapshots publish atomically and bytes are revalidated at consumption', async () => {
  await withRoot(async (root) => {
    const result = await cacheVerifiedArtifact(root, bytes)
    assert.deepEqual(readVerifiedArtifact(result), bytes)
    const again = await cacheVerifiedArtifact(root, bytes)
    assert.deepEqual(again, result)
    writeFileSync(result.path, Buffer.alloc(bytes.length))
    assert.throws(() => readVerifiedArtifact(result), /changed after verification/)
    await cacheVerifiedArtifact(root, bytes)
    assert.deepEqual(readVerifiedArtifact(result), bytes)
    assert.deepEqual(readdirSync(join(root, 'artifacts')), [result.key])
  })
})

test('tampered cache entries are repaired and symlinks never serve cached bytes', async () => {
  await withRoot(async (root) => {
    const first = await fetchArtifact(root, pin, { fetch: responseFetch() })
    writeFileSync(first.path, Buffer.alloc(bytes.length))
    let requests = 0
    const fetch = (async () => {
      requests++
      return new Response(bytes)
    }) as typeof globalThis.fetch
    await fetchArtifact(root, pin, { fetch })
    assert.equal(requests, 1)
    rmSync(first.path)
    const external = join(root, 'external')
    writeFileSync(external, bytes)
    symlinkSync(external, first.path)
    await fetchArtifact(root, pin, { fetch })
    assert.equal(requests, 2)
    assert.deepEqual(readFileSync(external), bytes)
  })
})

test('digest and declared size failures remove incomplete download files', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      fetchArtifact(root, pin, { fetch: responseFetch(Buffer.alloc(bytes.length)) }),
      /sha256 mismatch/
    )
    await assert.rejects(
      fetchArtifact(root, pin, { fetch: responseFetch(bytes.subarray(0, -1)) }),
      /size mismatch/
    )
    await assert.rejects(
      fetchArtifact(root, pin, { fetch: responseFetch(Buffer.concat([bytes, bytes])) }),
      /size bound/
    )
    assert.deepEqual(readdirSync(join(root, 'artifacts')), [])
  })
})

test('concurrent requests share one verified cache publication', async () => {
  await withRoot(async (root) => {
    let requests = 0
    const fetch = (async () => {
      requests++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new Response(bytes)
    }) as typeof globalThis.fetch
    const results = await Promise.all(
      Array.from({ length: 8 }, () => fetchArtifact(root, pin, { fetch }))
    )
    assert.equal(requests, 1)
    assert.ok(results.every((item) => item.path === results[0].path))
    assert.deepEqual(readdirSync(join(root, 'artifacts')), [results[0].key])
  })
})

test('cancellation interrupts a stalled body and cleans its partial file', async () => {
  await withRoot(async (root) => {
    const controller = new AbortController()
    const fetch = (async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(bytes.subarray(0, 3))
          }
        })
      )) as typeof globalThis.fetch
    const pending = fetchArtifact(root, pin, { fetch, signal: controller.signal })
    setTimeout(() => controller.abort(), 15)
    await assert.rejects(pending, { name: 'AbortError' })
    assert.deepEqual(readdirSync(join(root, 'artifacts')), [])
    await fetchArtifact(root, pin, { fetch: responseFetch() })
  })
})

test('a transport that aborts during its request does not leave an unhandled rejection', async () => {
  await withRoot(async (root) => {
    const controller = new AbortController()
    const fetch = (() => {
      controller.abort()
      return Promise.reject(new Error('transport aborted'))
    }) as typeof globalThis.fetch
    await assert.rejects(fetchArtifact(root, pin, { fetch, signal: controller.signal }), {
      name: 'AbortError'
    })
    assert.deepEqual(readdirSync(join(root, 'artifacts')), [])
  })
})

test('cancelled waiters do not abort another download or break cache serialization', async () => {
  await withRoot(async (root) => {
    let release!: () => void
    let requests = 0
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetch = (async () => {
      requests++
      await wait
      return new Response(bytes)
    }) as typeof globalThis.fetch
    const first = fetchArtifact(root, pin, { fetch })
    const controller = new AbortController()
    const cancelled = fetchArtifact(root, pin, { fetch, signal: controller.signal })
    controller.abort()
    await assert.rejects(cancelled, { name: 'AbortError' })
    const third = fetchArtifact(root, pin, { fetch })
    release()
    const [one, three] = await Promise.all([first, third])
    assert.equal(requests, 1)
    assert.equal(one.path, three.path)
  })
})

test('artifact URLs, redirects, integrity pins, and lengths fail closed', async () => {
  await withRoot(async (root) => {
    for (const url of [
      'http://example.test/a',
      'https://user:pass@example.test/a',
      'https://example.test/a#hash'
    ]) {
      await assert.rejects(
        fetchArtifact(root, { ...pin, url }, { fetch: responseFetch() }),
        /HTTPS/
      )
    }
    await assert.rejects(fetchArtifact(root, { ...pin, integrity: 'sha512-bad' }), /exactly one/)
    await assert.rejects(fetchArtifact(root, { url: pin.url, integrity: 'sha256-bad' }), /SHA512/)
    await assert.rejects(fetchArtifact(root, { ...pin, size: -1 }), /size/)
    let requests = 0
    await assert.rejects(
      fetchArtifact(root, pin, {
        fetch: (async () => {
          requests++
          return new Response(null, { status: 302, headers: { location: 'http://example.test/a' } })
        }) as typeof fetch
      }),
      /HTTPS/
    )
    assert.equal(requests, 1)
    await assert.rejects(
      fetchArtifact(root, pin, {
        fetch: (async () =>
          new Response(bytes, { headers: { 'content-length': '99999999' } })) as typeof fetch
      }),
      /content length/
    )
  })
})

test('installation assets require safe containment, regular files, and matching hashes', async () => {
  await withRoot((root) => {
    const source = join(root, 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'requirements.txt'), bytes)
    assert.deepEqual(readVerifiedInstallationAsset(source, './requirements.txt', pin.sha256), bytes)
    assert.throws(() => readVerifiedInstallationAsset(source, '../outside', pin.sha256), /unsafe/)
    assert.throws(
      () => readVerifiedInstallationAsset(source, 'requirements.txt', '0'.repeat(64)),
      /sha256 mismatch/
    )
    symlinkSync(join(source, 'requirements.txt'), join(source, 'alias'))
    assert.throws(() => readVerifiedInstallationAsset(source, 'alias', pin.sha256), /symlinks/)
    symlinkSync(source, join(source, 'nested'))
    assert.throws(
      () => readVerifiedInstallationAsset(source, 'nested/requirements.txt', pin.sha256),
      /symlinks/
    )
    const large = join(source, 'large')
    writeFileSync(large, '')
    truncateSync(large, 16 * 1024 * 1024 + 1)
    assert.throws(() => readVerifiedInstallationAsset(source, 'large', pin.sha256), /size bound/)
  })
})

test('specification hashes use deterministic recursively sorted fields', () => {
  assert.equal(
    installationSpecSha256({ backend: 'native', nested: { z: 2, a: 1 } }),
    installationSpecSha256({ nested: { a: 1, z: 2 }, backend: 'native' })
  )
  assert.notEqual(
    installationSpecSha256({ values: [1, 2] }),
    installationSpecSha256({ values: [2, 1] })
  )
})
