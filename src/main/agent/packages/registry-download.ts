import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'

import {
  assertSafeRegistryAssetPath,
  readRegistryAsset,
  registryAssetPath
} from './registry-assets'
import type { RegistryAsset } from './registry-assets'

export interface RegistryDownloadOptions {
  fetch?: typeof fetch
  baseUrl?: string
  timeoutMs?: number
}

export interface RegistryDownloadEndpoint {
  baseUrl: string
  redirect: RequestRedirect
  maxTimeoutMs?: number
}

type ReadRegistryChunk = (
  reader: ReadableStreamDefaultReader<Uint8Array>
) => Promise<ReadableStreamReadResult<Uint8Array>>

const DEFAULT_TIMEOUT_MS = 30_000
const archiveDownloads = new Map<string, Promise<void>>()

export async function fetchBytes(
  path: string,
  limit: number,
  options: RegistryDownloadOptions,
  endpoint: RegistryDownloadEndpoint
): Promise<Buffer> {
  return withRegistryResponse(path, limit, options, endpoint, async (response, readChunk) => {
    if (!response.body) throw new Error(`empty registry response: ${path}`)
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await readChunk(reader)
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > limit) throw new Error(`registry response exceeds size limit: ${path}`)
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return Buffer.concat(chunks, size)
  })
}

/** Keep a verified archive, otherwise stream one verified replacement into place. */
export async function ensureArchive(
  dir: string,
  asset: RegistryAsset,
  options: RegistryDownloadOptions,
  endpoint: RegistryDownloadEndpoint
): Promise<void> {
  try {
    readRegistryAsset(dir, asset)
    return
  } catch {
    // Missing and corrupt payloads are both replaced only after a verified download.
  }
  const path = registryAssetPath(dir, asset.path, true)
  let download = archiveDownloads.get(path)
  if (!download) {
    download = downloadAsset(dir, asset, options, endpoint).finally(() =>
      archiveDownloads.delete(path)
    )
    archiveDownloads.set(path, download)
  }
  await download
}

async function downloadAsset(
  dir: string,
  asset: RegistryAsset,
  options: RegistryDownloadOptions,
  endpoint: RegistryDownloadEndpoint
): Promise<void> {
  await withRegistryResponse(
    asset.path,
    asset.size,
    options,
    endpoint,
    async (response, readChunk) => {
      if (!response.body) throw new Error(`empty registry response: ${asset.path}`)
      const temporary = `${asset.path}.${randomUUID()}.tmp`
      const temporaryPath = registryAssetPath(dir, temporary, true)
      const reader = response.body.getReader()
      const hash = createHash('sha256')
      let size = 0
      let descriptor: number | undefined
      try {
        descriptor = openSync(temporaryPath, 'wx')
        while (true) {
          const chunk = await readChunk(reader)
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > asset.size) {
            throw new Error(`registry response exceeds size limit: ${asset.path}`)
          }
          const bytes = Buffer.from(chunk.value)
          hash.update(bytes)
          let offset = 0
          while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset)
        }
        closeSync(descriptor)
        descriptor = undefined
        if (size !== asset.size || hash.digest('hex') !== asset.sha256) {
          throw new Error(`registry asset size or checksum mismatch: ${asset.path}`)
        }
        renameSync(temporaryPath, registryAssetPath(dir, asset.path, true))
      } finally {
        await reader.cancel().catch(() => {})
        if (descriptor !== undefined) closeSync(descriptor)
        rmSync(temporaryPath, { force: true })
      }
    }
  )
}

async function withRegistryResponse<T>(
  path: string,
  limit: number,
  options: RegistryDownloadOptions,
  endpoint: RegistryDownloadEndpoint,
  consume: (response: Response, readChunk: ReadRegistryChunk) => Promise<T>
): Promise<T> {
  assertSafeRegistryAssetPath(path)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid registry size limit')
  const url = registryUrl(path, options.baseUrl ?? endpoint.baseUrl)
  const timeoutMs = registryTimeout(options.timeoutMs, endpoint.maxTimeoutMs)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      (options.fetch ?? fetch)(url, {
        signal: controller.signal,
        redirect: endpoint.redirect,
        headers: { Accept: 'application/octet-stream' }
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`registry fetch timed out: ${path}`))
        }, timeoutMs)
      })
    ])
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    validateRegistryResponse(response, path, limit)
    return await consume(response, createIdleReader(path, timeoutMs, controller))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function createIdleReader(
  path: string,
  timeoutMs: number,
  controller: AbortController
): ReadRegistryChunk {
  let deadline = Date.now() + timeoutMs
  return async (reader) => {
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        controller.abort()
        throw new Error(`registry fetch timed out: ${path}`)
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error(`registry fetch timed out: ${path}`))
            }, remaining)
          })
        ])
        if (chunk.done) return chunk
        if (chunk.value.byteLength > 0) {
          deadline = Date.now() + timeoutMs
          return chunk
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  }
}

function registryUrl(path: string, value: string): string {
  const base = new URL(value)
  if (base.protocol !== 'https:' || base.search || base.hash || base.username || base.password) {
    throw new Error('official registry endpoint must be an HTTPS directory')
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return new URL(path, base).href
}

function registryTimeout(value: number | undefined, maximum: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS
  const maxTimeoutMs = maximum ?? 60_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
    throw new Error('invalid registry fetch timeout')
  }
  return timeoutMs
}

function validateRegistryResponse(response: Response, path: string, limit: number): void {
  if (!response.ok) throw new Error(`registry fetch failed (${response.status}): ${path}`)
  const contentLength = response.headers.get('content-length')
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
    throw new Error(`registry response exceeds size limit: ${path}`)
  }
}

export async function boundedMap<T>(
  items: readonly T[],
  concurrency: number,
  action: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  let failure: unknown
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length && failure === undefined) {
        try {
          await action(items[cursor++])
        } catch (error) {
          failure = error
          throw error
        }
      }
    })
  )
  const rejected = outcomes.find((result) => result.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
}
