import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { transferFile } from '../src/main/agent/download/file-transfer'

test('transferFile resumes a partial response and verifies the complete file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-transfer-'))
  const destination = join(root, 'series.txt')
  const headersSeen: Record<string, string>[] = []
  try {
    let requests = 0
    const request = async (headers: Record<string, string>): Promise<Response> => {
      headersSeen.push(headers)
      requests += 1
      if (requests === 1) {
        let reads = 0
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              reads += 1
              if (reads === 1) controller.enqueue(Buffer.from('abc'))
              else controller.error(new Error('connection lost'))
            }
          }),
          { headers: { ETag: '"v1"', 'Content-Length': '6' } }
        )
      }
      return new Response('def', {
        status: 206,
        headers: { ETag: '"v1"', 'Content-Range': 'bytes 3-5/6', 'Content-Length': '3' }
      })
    }

    const result = await transferFile({
      url: 'https://example.org/series.txt',
      destination,
      maxBytes: 100,
      request,
      sleep: async () => undefined
    })
    assert.equal(await readFile(destination, 'utf8'), 'abcdef')
    assert.equal(result.bytes, 6)
    assert.equal(result.attempts, 2)
    assert.equal(result.resumed, true)
    assert.equal(result.sha256, `sha256:${createHash('sha256').update('abcdef').digest('hex')}`)
    assert.deepEqual(headersSeen[1], { Range: 'bytes=3-', 'If-Range': '"v1"' })
    await assert.rejects(stat(`${destination}.part`), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('transferFile rejects oversized responses without replacing the destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-transfer-'))
  const destination = join(root, 'large.bin')
  try {
    await assert.rejects(
      transferFile({
        url: 'https://example.org/large.bin',
        destination,
        maxBytes: 2,
        maxAttempts: 1,
        request: async () => new Response('large')
      }),
      /exceeds maximum size/
    )
    await assert.rejects(stat(destination), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('transferFile does not delete an unrelated staging file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-transfer-'))
  const destination = join(root, 'data.txt')
  try {
    await writeFile(`${destination}.part`, 'user data')
    await assert.rejects(
      transferFile({
        url: 'https://example.org/data.txt',
        destination,
        maxBytes: 100,
        request: async () => new Response('new data')
      }),
      /staging files already exist/
    )
    assert.equal(await readFile(`${destination}.part`, 'utf8'), 'user data')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('transferFile aborts a stalled response and retries the transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-transfer-'))
  const destination = join(root, 'stall.txt')
  try {
    let requests = 0
    let aborted = false
    const result = await transferFile({
      url: 'https://example.org/stall.txt',
      destination,
      maxBytes: 100,
      idleTimeoutMs: 10,
      sleep: async () => undefined,
      request: async (_headers, signal) => {
        requests += 1
        if (requests > 1) return new Response('finished')
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => {
                aborted = true
                controller.error(new Error('aborted'))
              })
            }
          })
        )
      }
    })
    assert.equal(result.attempts, 2)
    assert.equal(aborted, true)
    assert.equal(await readFile(destination, 'utf8'), 'finished')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('transferFile prevents concurrent writes to one destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-transfer-'))
  const destination = join(root, 'shared.txt')
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const first = transferFile({
      url: 'https://example.org/shared.txt',
      destination,
      maxBytes: 100,
      request: async () => {
        await held
        return new Response('first')
      }
    })
    await assert.rejects(
      transferFile({
        url: 'https://example.org/other.txt',
        destination,
        maxBytes: 100,
        request: async () => new Response('second')
      }),
      /already in progress/
    )
    release()
    await first
    assert.equal(await readFile(destination, 'utf8'), 'first')
  } finally {
    release()
    await rm(root, { recursive: true, force: true })
  }
})

test('transferFile restarts from zero when a server rejects the saved range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-transfer-'))
  const destination = join(root, 'range.txt')
  const url = 'https://example.org/range.txt'
  try {
    await assert.rejects(
      transferFile({
        url,
        destination,
        maxBytes: 100,
        maxAttempts: 1,
        request: async () => {
          let reads = 0
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                reads += 1
                if (reads === 1) controller.enqueue(Buffer.from('abc'))
                else controller.error(new Error('connection lost'))
              }
            }),
            { headers: { ETag: '"v1"', 'Content-Length': '6' } }
          )
        }
      }),
      /connection lost/
    )

    const seen: Record<string, string>[] = []
    const result = await transferFile({
      url,
      destination,
      maxBytes: 100,
      sleep: async () => undefined,
      request: async (headers) => {
        seen.push(headers)
        if (seen.length === 1) {
          throw Object.assign(new Error('Range not satisfiable'), {
            status: 416,
            retryable: false
          })
        }
        return new Response('abcdef')
      }
    })
    assert.deepEqual(seen[0], { Range: 'bytes=3-', 'If-Range': '"v1"' })
    assert.deepEqual(seen[1], {})
    assert.equal(result.bytes, 6)
    assert.equal(await readFile(destination, 'utf8'), 'abcdef')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
