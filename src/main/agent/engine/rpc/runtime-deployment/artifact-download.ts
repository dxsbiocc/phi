import { constants } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'

import { desktopFetch } from '../../../desktop-fetch'

import {
  classifyResponse,
  DownloadHttpError,
  DownloadResponseError,
  readPartial,
  requestForPartial,
  settleNonAppend,
  writePartialMetadata,
  type AppendResponse,
  type ArtifactDownloadStorage,
  type ArtifactPartialPaths
} from './artifact-download-response'
import { RemoteOmpDeploymentError, type RemoteOmpAsset } from './types'

export { DownloadResponseError } from './artifact-download-response'
export type { ArtifactDownloadStorage, ArtifactPartialPaths } from './artifact-download-response'

export interface RemoteOmpDownloadProgress {
  readonly bytesReceived: number
  readonly totalBytes?: number
  readonly attempt: number
}

export interface RemoteOmpDownloadOptions {
  asset: RemoteOmpAsset
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onProgress?: (progress: RemoteOmpDownloadProgress) => void
  /** Test seam; production waits 30 seconds without response bytes. */
  inactivityTimeoutMs?: number
  /** Test seam; production makes five bounded attempts. */
  maxAttempts?: number
  /** Base delay for exponential retry backoff. */
  retryDelayMs?: number
}

interface DownloadAttemptInput {
  readonly options: RemoteOmpDownloadOptions
  readonly paths: ArtifactPartialPaths
  readonly localPath: string
  readonly attempt: number
  readonly inactivityTimeoutMs: number
  readonly storage: ArtifactDownloadStorage
  readonly report: (bytesReceived: number, totalBytes: number | undefined, attempt: number) => void
}

interface DownloadConfig {
  readonly inactivityTimeoutMs: number
  readonly maxAttempts: number
  readonly retryDelayMs: number
}

const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_RETRY_DELAY_MS = 1_000
export const REMOTE_OMP_PRESEED_GUIDANCE =
  'Follow docs/runtime/remote-omp-preseed.md to preseed the pinned runtime, then retry.'

class DownloadStallError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`network stalled for ${timeoutMs} ms without receiving bytes`)
    this.name = 'DownloadStallError'
  }
}

async function openPartialFile(
  path: string,
  offset: number,
  storage: ArtifactDownloadStorage
): Promise<FileHandle> {
  const entry = await storage.cacheEntry(path)
  if (!entry) {
    if (offset !== 0) throw new DownloadResponseError('partial file disappeared before resume')
    return open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
  }
  await storage.secureFile(path)
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    storage.assertFile(info, path)
    if (info.size !== offset) throw new DownloadResponseError('partial size changed unexpectedly')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten <= 0) throw new Error('OMP partial write made no progress')
    offset += bytesWritten
  }
}

function inactivityWatch(
  controller: AbortController,
  timeoutMs: number
): { reset(): void; clear(): void } {
  let timer: NodeJS.Timeout | undefined
  return {
    reset() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => controller.abort(new DownloadStallError(timeoutMs)), timeoutMs)
    },
    clear() {
      if (timer) clearTimeout(timer)
      timer = undefined
    }
  }
}

async function streamResponse(
  response: Response,
  disposition: AppendResponse,
  input: DownloadAttemptInput,
  watch: ReturnType<typeof inactivityWatch>
): Promise<number> {
  const handle = await openPartialFile(input.paths.file, disposition.offset, input.storage)
  const reader = response.body!.getReader()
  let bytesReceived = disposition.offset
  try {
    while (true) {
      const chunk = await reader.read()
      input.options.signal?.throwIfAborted()
      if (chunk.done) return bytesReceived
      watch.reset()
      await writeAll(handle, chunk.value)
      bytesReceived += chunk.value.byteLength
      if (disposition.totalBytes !== undefined && bytesReceived > disposition.totalBytes) {
        throw new DownloadResponseError('response exceeded the expected artifact size')
      }
      input.report(bytesReceived, disposition.totalBytes, input.attempt)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await handle.close()
  }
}

async function finalizeDownload(
  bytesReceived: number,
  disposition: AppendResponse,
  input: DownloadAttemptInput
): Promise<number> {
  if (disposition.totalBytes !== undefined && bytesReceived !== disposition.totalBytes) {
    throw new Error(`network ended after ${bytesReceived} of ${disposition.totalBytes} bytes`)
  }
  const size = await input.storage.publish(
    input.paths,
    input.localPath,
    input.options.asset,
    input.options.signal
  )
  input.report(size, disposition.totalBytes ?? size, input.attempt)
  return size
}

async function appendResponse(
  response: Response,
  disposition: AppendResponse,
  input: DownloadAttemptInput,
  watch: ReturnType<typeof inactivityWatch>
): Promise<number> {
  if (disposition.discardExisting) await input.storage.discard(input.paths)
  await writePartialMetadata(input.paths.metadata, disposition.metadata, input.storage)
  const bytesReceived = await streamResponse(response, disposition, input, watch)
  watch.clear()
  return finalizeDownload(bytesReceived, disposition, input)
}

async function requestAndAppend(
  input: DownloadAttemptInput,
  partial: Awaited<ReturnType<typeof readPartial>>,
  controller: AbortController,
  watch: ReturnType<typeof inactivityWatch>
): Promise<{ size?: number; restart: boolean }> {
  const response = await desktopFetch(input.options.fetchImpl)(
    input.options.asset.url,
    requestForPartial(partial, controller.signal)
  )
  input.options.signal?.throwIfAborted()
  const disposition = classifyResponse(response, partial, input.options.asset)
  if (disposition.action !== 'append') {
    return settleNonAppend(disposition, response, input.paths, input.storage)
  }
  return { size: await appendResponse(response, disposition, input, watch), restart: false }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  const abort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return abort
}

async function downloadAttempt(input: DownloadAttemptInput): Promise<{
  size?: number
  restart: boolean
}> {
  const { options, paths, storage } = input
  options.signal?.throwIfAborted()
  const partial = await readPartial(paths, options.asset, storage)
  const knownTotal = options.asset.size ?? partial?.metadata.expectedSize
  if (partial && knownTotal !== undefined && partial.size === knownTotal) {
    return {
      size: await storage.publish(paths, input.localPath, options.asset, options.signal),
      restart: false
    }
  }
  input.report(partial?.size ?? 0, knownTotal, input.attempt)
  const controller = new AbortController()
  const abort = forwardAbort(options.signal, controller)
  const watch = inactivityWatch(controller, input.inactivityTimeoutMs)
  watch.reset()
  try {
    return await requestAndAppend(input, partial, controller, watch)
  } catch (error) {
    options.signal?.throwIfAborted()
    if (controller.signal.reason instanceof DownloadStallError) throw controller.signal.reason
    throw error
  } finally {
    watch.clear()
    options.signal?.removeEventListener('abort', abort)
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RemoteOmpDeploymentError('INVALID_ARGUMENT', `${name} must be a positive integer.`)
  }
  return selected
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new RemoteOmpDeploymentError(
      'INVALID_ARGUMENT',
      `${name} must be a non-negative integer.`
    )
  }
  return selected
}

function downloadConfig(options: RemoteOmpDownloadOptions): DownloadConfig {
  return {
    inactivityTimeoutMs: positiveInteger(
      options.inactivityTimeoutMs,
      DEFAULT_INACTIVITY_TIMEOUT_MS,
      'OMP download inactivity timeout'
    ),
    maxAttempts: positiveInteger(
      options.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
      'OMP download attempt count'
    ),
    retryDelayMs: nonNegativeInteger(
      options.retryDelayMs,
      DEFAULT_RETRY_DELAY_MS,
      'OMP download retry delay'
    )
  }
}

function progressReporter(options: RemoteOmpDownloadOptions): DownloadAttemptInput['report'] {
  let maximumReported = 0
  return (bytesReceived, totalBytes, attempt) => {
    maximumReported = Math.max(maximumReported, bytesReceived)
    options.onProgress?.({ bytesReceived: maximumReported, totalBytes, attempt })
  }
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (delayMs === 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    function finish(): void {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

function failureAfterRetries(error: unknown, attempts: number): RemoteOmpDeploymentError {
  const suffix = ` after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}. ${REMOTE_OMP_PRESEED_GUIDANCE}`
  if (error instanceof DownloadStallError) {
    return new RemoteOmpDeploymentError(
      'DOWNLOAD_FAILED',
      `OMP download failed because the network stalled for ${error.timeoutMs} ms without receiving bytes${suffix}`,
      { cause: error, errorDetail: { cause: 'stall', stallMs: error.timeoutMs, attempts } }
    )
  }
  if (error instanceof DownloadHttpError) {
    return new RemoteOmpDeploymentError(
      'DOWNLOAD_FAILED',
      `OMP download failed with HTTP ${error.status}${suffix}`,
      { cause: error, errorDetail: { cause: 'http', httpStatus: error.status, attempts } }
    )
  }
  if (error instanceof DownloadResponseError) {
    return new RemoteOmpDeploymentError(
      'DOWNLOAD_FAILED',
      `OMP download received an invalid response (${error.message})${suffix}`,
      { cause: error, errorDetail: { cause: 'invalid_response', attempts } }
    )
  }
  return new RemoteOmpDeploymentError(
    'DOWNLOAD_FAILED',
    `OMP download failed because the network connection ended before the artifact was complete${suffix}`,
    { cause: error, errorDetail: { cause: 'network', attempts } }
  )
}

async function downloadUntilSettled(input: DownloadAttemptInput): Promise<number> {
  while (true) {
    const result = await downloadAttempt(input)
    if (!result.restart) return result.size!
  }
}

export async function downloadRemoteOmpArtifact(
  options: RemoteOmpDownloadOptions,
  paths: ArtifactPartialPaths,
  localPath: string,
  storage: ArtifactDownloadStorage
): Promise<number> {
  const config = downloadConfig(options)
  const report = progressReporter(options)
  let lastError: unknown
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await downloadUntilSettled({
        options,
        paths,
        localPath,
        attempt,
        inactivityTimeoutMs: config.inactivityTimeoutMs,
        storage,
        report
      })
    } catch (error) {
      options.signal?.throwIfAborted()
      if (error instanceof RemoteOmpDeploymentError) throw error
      if (error instanceof DownloadResponseError) await storage.discard(paths)
      lastError = error
      if (attempt < config.maxAttempts) {
        await abortableDelay(config.retryDelayMs * 2 ** (attempt - 1), options.signal)
      }
    }
  }
  throw failureAfterRetries(lastError, config.maxAttempts)
}
