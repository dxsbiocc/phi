import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { sha256 } from '../src/main/agent/packages/installer-utils'
import { ensureArchive, fetchBytes } from '../src/main/agent/packages/registry-download'

const endpoint = {
  baseUrl: 'https://example.test/registry/',
  redirect: 'error' as const,
  maxTimeoutMs: 1_000
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function spacedStream(
  chunks: readonly Uint8Array[],
  intervalMs: number
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    async pull(controller) {
      await delay(intervalMs)
      const chunk = chunks[index++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    }
  })
}

test('fetchBytes allows a long response while bytes keep arriving within the idle timeout', async () => {
  const chunks = ['slow', '-', 'but', '-', 'active'].map((value) => Buffer.from(value))

  const bytes = await fetchBytes(
    'index.json',
    1024,
    {
      timeoutMs: 100,
      fetch: async () => new Response(spacedStream(chunks, 30))
    },
    endpoint
  )

  assert.equal(bytes.toString(), 'slow-but-active')
})

test('fetchBytes fails when the response body stalls past the idle timeout', async () => {
  await assert.rejects(
    fetchBytes(
      'index.json',
      1024,
      {
        timeoutMs: 30,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from('partial'))
              }
            })
          )
      },
      endpoint
    ),
    /registry fetch timed out: index\.json/
  )
})

test('ensureArchive allows a long download while bytes keep arriving within the idle timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-registry-download-'))
  roots.push(root)
  const chunks = ['slow', '-', 'archive', '-', 'active'].map((value) => Buffer.from(value))
  const bytes = Buffer.concat(chunks)
  const asset = { path: 'skill-slow-1.0.0.tar.gz', sha256: sha256(bytes), size: bytes.length }

  await ensureArchive(
    root,
    asset,
    {
      timeoutMs: 100,
      fetch: async () => new Response(spacedStream(chunks, 30))
    },
    endpoint
  )

  assert.deepEqual(readFileSync(join(root, asset.path)), bytes)
})

test('ensureArchive removes its temporary file when the response body stalls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-registry-download-'))
  roots.push(root)
  const bytes = Buffer.from('complete archive')
  const asset = {
    path: 'skill-stalled-1.0.0.tar.gz',
    sha256: sha256(bytes),
    size: bytes.length
  }

  await assert.rejects(
    ensureArchive(
      root,
      asset,
      {
        timeoutMs: 30,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from('partial'))
              }
            })
          )
      },
      endpoint
    ),
    /registry fetch timed out: skill-stalled-1\.0\.0\.tar\.gz/
  )
  assert.equal(existsSync(join(root, asset.path)), false)
  assert.deepEqual(readdirSync(root), [])
})
