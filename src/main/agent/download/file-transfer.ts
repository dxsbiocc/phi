import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const activeDestinations = new Set<string>()

interface PartialDownload {
  urlHash: string
  validator?: string
  totalBytes?: number
}

export interface FileTransferOptions {
  url: string
  destination: string
  maxBytes: number
  request: (headers: Record<string, string>, signal: AbortSignal) => Promise<Response>
  signal?: AbortSignal
  maxAttempts?: number
  idleTimeoutMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  onProgress?: (bytes: number, totalBytes?: number) => void
}

export interface FileTransferResult {
  path: string
  bytes: number
  sha256: string
  attempts: number
  resumed: boolean
}

function parseLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function isNonRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false
  )
}

function isRangeNotSatisfiable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 416
}

function contentRange(value: string | null): { start: number; total?: number } | undefined {
  const match = value?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/i)
  if (!match) return undefined
  const start = Number(match[1])
  const total = match[2] === '*' ? undefined : Number(match[2])
  if (!Number.isSafeInteger(start) || (total !== undefined && !Number.isSafeInteger(total))) {
    return undefined
  }
  return { start, total }
}

async function readPartial(path: string, urlHash: string): Promise<PartialDownload | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PartialDownload
    return parsed.urlHash === urlHash ? parsed : undefined
  } catch {
    return undefined
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function assertRegularOrMissing(path: string): Promise<void> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile()) throw new Error(`Download staging path is not a regular file: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('Download cancelled')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    function abort(): void {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Download cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  controller: AbortController
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Download stalled while reading the response'))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted()
    hash.update(chunk)
  }
  signal?.throwIfAborted()
  return `sha256:${hash.digest('hex')}`
}

export async function transferFile(options: FileTransferOptions): Promise<FileTransferResult> {
  const destination = resolve(options.destination)
  if (activeDestinations.has(destination)) {
    throw new Error(`Download already in progress for ${destination}`)
  }
  activeDestinations.add(destination)
  try {
    return await transferFileUnlocked({ ...options, destination })
  } finally {
    activeDestinations.delete(destination)
  }
}

async function transferFileUnlocked(options: FileTransferOptions): Promise<FileTransferResult> {
  const maxAttempts = options.maxAttempts ?? 3
  const partialPath = `${options.destination}.part`
  const metadataPath = `${partialPath}.json`
  const urlHash = createHash('sha256').update(options.url).digest('hex')
  await mkdir(dirname(options.destination), { recursive: true })
  await assertRegularOrMissing(partialPath)
  await assertRegularOrMissing(metadataPath)
  let resumed = false
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Download cancelled')
    let offset = await sizeOf(partialPath)
    let metadata = await readPartial(metadataPath, urlHash)
    if (!metadata && (offset > 0 || (await sizeOf(metadataPath)) > 0)) {
      throw new Error('Download staging files already exist for another or unknown transfer')
    }
    if (offset > 0 && (!metadata?.validator || offset > options.maxBytes)) {
      await removeIfExists(partialPath)
      await removeIfExists(metadataPath)
      offset = 0
      metadata = undefined
    }
    if (offset > 0 && metadata?.totalBytes === offset) {
      const sha256 = await hashFile(partialPath)
      await rename(partialPath, options.destination)
      await removeIfExists(metadataPath)
      return {
        path: options.destination,
        bytes: offset,
        sha256,
        attempts: attempt - 1,
        resumed: true
      }
    }

    const controller = new AbortController()
    const abort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const headers: Record<string, string> =
        offset > 0 && metadata?.validator
          ? { Range: `bytes=${offset}-`, 'If-Range': metadata.validator }
          : {}
      const response = await options.request(headers, controller.signal)
      const range = contentRange(response.headers.get('content-range'))
      if (offset > 0 && response.status === 206) {
        if (
          !range ||
          range.start !== offset ||
          (metadata?.totalBytes !== undefined && range.total !== metadata.totalBytes) ||
          (response.headers.get('etag') && response.headers.get('etag') !== metadata?.validator) ||
          (response.headers.get('last-modified') &&
            response.headers.get('last-modified') !== metadata?.validator)
        ) {
          throw new Error('Download server returned a mismatched byte range')
        }
        resumed = true
      } else if (response.status === 200) {
        offset = 0
      } else {
        throw new Error(`Download server returned HTTP ${response.status}`)
      }
      const contentLength = parseLength(response.headers.get('content-length'))
      const totalBytes =
        range?.total ?? (contentLength !== undefined ? offset + contentLength : undefined)
      if (totalBytes !== undefined && totalBytes > options.maxBytes) {
        throw new Error(`Download exceeds maximum size of ${options.maxBytes} bytes`)
      }
      if (!response.body) throw new Error('Download response has no body')

      const validator =
        response.headers.get('etag') ??
        response.headers.get('last-modified') ??
        (offset > 0 ? metadata?.validator : undefined)
      await writeFile(metadataPath, JSON.stringify({ urlHash, validator, totalBytes }))
      const handle = await open(partialPath, offset > 0 ? 'a' : 'w')
      let bytes = offset
      try {
        const reader = response.body.getReader()
        try {
          while (true) {
            const chunk = await readChunk(reader, options.idleTimeoutMs ?? 30_000, controller)
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > options.maxBytes) {
              throw new Error(`Download exceeds maximum size of ${options.maxBytes} bytes`)
            }
            await handle.writeFile(chunk.value)
            options.onProgress?.(bytes, totalBytes)
          }
        } finally {
          reader.releaseLock()
        }
      } finally {
        await handle.close()
      }
      if (totalBytes !== undefined && bytes !== totalBytes) {
        throw new Error(`Download ended at ${bytes} of ${totalBytes} bytes`)
      }
      const sha256 = await hashFile(partialPath)
      await rename(partialPath, options.destination)
      await removeIfExists(metadataPath)
      return { path: options.destination, bytes, sha256, attempts: attempt, resumed }
    } catch (error) {
      lastError = error
      if (controller.signal.aborted && options.signal?.aborted) throw error
      const message = String(error)
      if (
        /exceeds maximum size|mismatched byte range/.test(message) ||
        (offset > 0 && isRangeNotSatisfiable(error))
      ) {
        await removeIfExists(partialPath)
        await removeIfExists(metadataPath)
      }
      if (
        attempt === maxAttempts ||
        (isNonRetryable(error) && !(offset > 0 && isRangeNotSatisfiable(error))) ||
        /exceeds maximum size/.test(message)
      ) {
        throw error
      }
      await (options.sleep ?? pause)(Math.min(500 * 2 ** (attempt - 1), 4_000), options.signal)
    } finally {
      options.signal?.removeEventListener('abort', abort)
      controller.abort()
    }
  }
  throw lastError
}
