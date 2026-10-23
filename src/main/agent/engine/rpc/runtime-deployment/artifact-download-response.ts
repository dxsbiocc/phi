import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'

import type { RemoteOmpAsset } from './types'

export interface ArtifactPartialPaths {
  readonly file: string
  readonly metadata: string
}

export interface ArtifactDownloadStorage {
  cacheEntry(path: string): Promise<Stats | undefined>
  secureFile(path: string): Promise<Stats>
  assertFile(info: Stats, path: string): void
  discard(paths: ArtifactPartialPaths): Promise<void>
  publish(
    paths: ArtifactPartialPaths,
    localPath: string,
    asset: RemoteOmpAsset,
    signal?: AbortSignal
  ): Promise<number>
}

interface PartialMetadata {
  readonly schema: 1
  readonly url: string
  readonly sha256: string
  readonly expectedSize?: number
  readonly etag?: string
  readonly lastModified?: string
}

export interface PartialState {
  readonly size: number
  readonly metadata: PartialMetadata
}

interface ContentRange {
  readonly start: number
  readonly end: number
  readonly total: number
}

export interface AppendResponse {
  readonly action: 'append'
  readonly offset: number
  readonly totalBytes?: number
  readonly metadata: PartialMetadata
  readonly discardExisting: boolean
}

export type ResponseDisposition =
  | AppendResponse
  | { readonly action: 'restart' }
  | { readonly action: 'fail'; readonly error: Error; readonly discard: boolean }

type ContentResponseDisposition = ResponseDisposition | null

export class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'DownloadHttpError'
  }
}

export class DownloadResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadResponseError'
  }
}

function validMetadata(value: unknown): value is PartialMetadata {
  if (!value || typeof value !== 'object') return false
  const metadata = value as Partial<PartialMetadata>
  return (
    metadata.schema === 1 &&
    typeof metadata.url === 'string' &&
    typeof metadata.sha256 === 'string' &&
    (metadata.expectedSize === undefined ||
      (Number.isSafeInteger(metadata.expectedSize) && metadata.expectedSize > 0)) &&
    (metadata.etag === undefined || typeof metadata.etag === 'string') &&
    (metadata.lastModified === undefined || typeof metadata.lastModified === 'string')
  )
}

function partialMatchesAsset(
  metadata: PartialMetadata,
  fileSize: number,
  asset: RemoteOmpAsset
): boolean {
  const expectedSize = asset.size ?? metadata.expectedSize
  return (
    metadata.url === asset.url &&
    metadata.sha256 === asset.sha256 &&
    (asset.size === undefined || metadata.expectedSize === asset.size) &&
    (expectedSize === undefined || fileSize <= expectedSize)
  )
}

export async function readPartial(
  paths: ArtifactPartialPaths,
  asset: RemoteOmpAsset,
  storage: ArtifactDownloadStorage
): Promise<PartialState | null> {
  const fileEntry = await storage.cacheEntry(paths.file)
  const metadataEntry = await storage.cacheEntry(paths.metadata)
  if (!fileEntry && !metadataEntry) return null
  if (fileEntry) await storage.secureFile(paths.file)
  if (metadataEntry) await storage.secureFile(paths.metadata)
  if (!fileEntry || !metadataEntry) {
    await storage.discard(paths)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(paths.metadata, 'utf8'))
  } catch {
    await storage.discard(paths)
    return null
  }
  if (!validMetadata(parsed) || !partialMatchesAsset(parsed, fileEntry.size, asset)) {
    await storage.discard(paths)
    return null
  }
  return { size: fileEntry.size, metadata: parsed }
}

export async function writePartialMetadata(
  path: string,
  metadata: PartialMetadata,
  storage: ArtifactDownloadStorage
): Promise<void> {
  if (await storage.cacheEntry(path)) await storage.secureFile(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 })
    await storage.secureFile(temporary)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function parseContentRange(value: string | null): ContentRange | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '')
  if (!match) return null
  const [, startText, endText, totalText] = match
  const start = Number(startText)
  const end = Number(endText)
  const total = Number(totalText)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  )
    return null
  return { start, end, total }
}

function responseLength(response: Response): number | undefined {
  const header = response.headers.get('content-length')
  if (header === null) return undefined
  const value = Number(header)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function responseValidator(response: Response): Pick<PartialMetadata, 'etag' | 'lastModified'> {
  const etag = response.headers.get('etag')?.trim()
  const lastModified = response.headers.get('last-modified')?.trim()
  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {})
  }
}

function validatorChanged(metadata: PartialMetadata, response: Response): boolean {
  const current = responseValidator(response)
  return Boolean(
    (metadata.etag && current.etag && metadata.etag !== current.etag) ||
    (!metadata.etag &&
      metadata.lastModified &&
      current.lastModified &&
      metadata.lastModified !== current.lastModified)
  )
}

function responseMetadata(
  asset: RemoteOmpAsset,
  partial: PartialState | null,
  response: Response,
  totalBytes: number | undefined
): PartialMetadata {
  const validators = responseValidator(response)
  const etag = validators.etag ?? partial?.metadata.etag
  const lastModified = validators.lastModified ?? partial?.metadata.lastModified
  return {
    schema: 1,
    url: asset.url,
    sha256: asset.sha256,
    ...(totalBytes === undefined ? {} : { expectedSize: totalBytes }),
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {})
  }
}

function invalidRange(response: Response, range: ContentRange | null, offset: number): boolean {
  if (response.status !== 206) return false
  const length = responseLength(response)
  return Boolean(
    !range ||
    range.start !== offset ||
    (length !== undefined && length !== range.end - range.start + 1)
  )
}

function invalidTotal(
  asset: RemoteOmpAsset,
  partial: PartialState | null,
  response: Response,
  totalBytes: number | undefined
): boolean {
  return Boolean(
    (asset.size !== undefined && totalBytes !== asset.size) ||
    (partial?.metadata.expectedSize !== undefined &&
      response.status === 206 &&
      totalBytes !== partial.metadata.expectedSize)
  )
}

function statusDisposition(
  response: Response,
  requestedOffset: number
): ContentResponseDisposition {
  if (requestedOffset > 0 && response.status === 416) return { action: 'restart' }
  if (![200, 206].includes(response.status) || !response.body) {
    return { action: 'fail', error: new DownloadHttpError(response.status), discard: false }
  }
  return null
}

function resumedResponseDisposition(
  response: Response,
  partial: PartialState | null,
  range: ContentRange | null,
  requestedOffset: number
): ContentResponseDisposition {
  if (invalidRange(response, range, requestedOffset)) {
    return {
      action: 'fail',
      error: new DownloadResponseError('Content-Range does not match the requested partial'),
      discard: true
    }
  }
  if (partial && response.status === 206 && validatorChanged(partial.metadata, response)) {
    return { action: 'restart' }
  }
  return null
}

function appendDisposition(
  response: Response,
  partial: PartialState | null,
  range: ContentRange | null,
  asset: RemoteOmpAsset,
  requestedOffset: number
): ResponseDisposition {
  const offset = requestedOffset > 0 && response.status === 200 ? 0 : requestedOffset
  const length = responseLength(response)
  const totalBytes =
    asset.size ?? range?.total ?? (length === undefined ? undefined : offset + length)
  if (invalidTotal(asset, partial, response, totalBytes)) {
    return {
      action: 'fail',
      error: new DownloadResponseError('response size does not match the pinned artifact'),
      discard: true
    }
  }
  return {
    action: 'append',
    offset,
    totalBytes,
    metadata: responseMetadata(asset, partial, response, totalBytes),
    discardExisting: requestedOffset > 0 && response.status === 200
  }
}

export function classifyResponse(
  response: Response,
  partial: PartialState | null,
  asset: RemoteOmpAsset
): ResponseDisposition {
  const requestedOffset = partial?.size ?? 0
  const status = statusDisposition(response, requestedOffset)
  if (status) return status
  const range =
    response.status === 206 ? parseContentRange(response.headers.get('content-range')) : null
  const resumed = resumedResponseDisposition(response, partial, range, requestedOffset)
  return resumed ?? appendDisposition(response, partial, range, asset, requestedOffset)
}

export function requestForPartial(partial: PartialState | null, signal: AbortSignal): RequestInit {
  const headers = new Headers()
  if (partial && partial.size > 0) {
    headers.set('range', `bytes=${partial.size}-`)
    const validator = partial.metadata.etag ?? partial.metadata.lastModified
    if (validator) headers.set('if-range', validator)
  }
  return { signal, headers, redirect: 'follow', credentials: 'omit' }
}

export async function settleNonAppend(
  disposition: Exclude<ResponseDisposition, AppendResponse>,
  response: Response,
  paths: ArtifactPartialPaths,
  storage: ArtifactDownloadStorage
): Promise<{ restart: true }> {
  await response.body?.cancel()
  if (disposition.action === 'restart' || disposition.discard) await storage.discard(paths)
  if (disposition.action === 'fail') throw disposition.error
  return { restart: true }
}
