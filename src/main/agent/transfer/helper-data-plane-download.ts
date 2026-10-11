import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, statfs, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path'

import type {
  PartialInspection,
  TransferCopyOptions,
  TransferDataPlaneSession,
  TransferPreflight
} from './data-plane'
import { TransferError } from './errors'
import type {
  HelperTransferDataPlaneOptions,
  NegotiatedHelperConnection
} from './helper-data-plane'
import {
  HELPER_DATA_PLANE_CHUNK_BYTES,
  HelperBinaryFrameType,
  HelperProtocolError,
  type HelperDataPlaneProtocolClient
} from './helper-data-plane-protocol'
import { parseTransferManifest, sameSourceIdentity, type TransferManifest } from './manifest'
import {
  hashLocalFile,
  hashVerifiedLocalFile,
  inspectLocalPath,
  localOwnerId,
  publishVerifiedLocalFile,
  type VerifiedLocalFile,
  transferAbortError
} from './ssh-data-plane-local'
import type { TransferProgress, TransferRequest, TransferSourceIdentity } from './types'

const MAX_MANIFEST_BYTES = 64 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type DownloadOpenResult = Readonly<{
  offset: number
  chunkSize: number
  window: number
  sourceIdentity: TransferSourceIdentity
}>

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function checkedRemoteRelativePath(value: string): string {
  if (
    !value ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '.' ||
    value.split('/').includes('..') ||
    /[\0\r\n]/.test(value)
  ) {
    throw new TransferError(
      'INVALID_REQUEST',
      'Remote transfer path must stay inside the workspace'
    )
  }
  return value
}

function checkedIdentity(value: TransferSourceIdentity): TransferSourceIdentity {
  if (
    !value ||
    value.kind !== 'file' ||
    typeof value.device !== 'string' ||
    typeof value.inode !== 'string' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.mtime !== 'string'
  ) {
    throw new TransferError('TRANSFER_FAILED', 'Remote helper returned an invalid source identity')
  }
  return value
}

function checkedHash(value: unknown): string {
  const hash = (value as { hash?: unknown })?.hash
  if (typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) {
    throw new TransferError('TRANSFER_FAILED', 'Remote helper returned an invalid SHA-256')
  }
  return hash
}

function mappedHelperError(error: unknown): unknown {
  if (!(error instanceof HelperProtocolError) || !error.domainCode) return error
  switch (error.domainCode) {
    case 'HASH_MISMATCH':
      return new TransferError('HASH_MISMATCH', error.message)
    case 'OFFSET_MISMATCH':
    case 'INVALID_PARTIAL':
    case 'TRANSFER_BUSY':
    case 'TRANSFER_NOT_OPEN':
      return new TransferError('INVALID_PARTIAL', error.message)
    case 'PATH_OUTSIDE_ROOT':
    case 'INVALID_ARGUMENT':
      return new TransferError('INVALID_REQUEST', error.message)
    default:
      return error
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class HelperDownloadSession implements TransferDataPlaneSession {
  readonly destinationKey: string
  readonly partialLocator: string
  readonly manifestLocator: string
  private readonly sourcePath: string
  private readonly destination: string
  private sourceIdentity?: TransferSourceIdentity
  private verifiedPartial?: VerifiedLocalFile

  constructor(
    private readonly request: TransferRequest,
    private readonly options: HelperTransferDataPlaneOptions,
    private readonly connect: () => Promise<NegotiatedHelperConnection>
  ) {
    if (
      request.source.kind !== 'remote-workspace-path' ||
      request.destination.kind !== 'local-path' ||
      request.source.hostId !== options.hostId ||
      request.source.workspaceId !== options.workspaceId ||
      !isAbsolute(request.destination.path)
    ) {
      throw new TransferError(
        'INVALID_REQUEST',
        'Helper download requires authorized workspace-to-local endpoints'
      )
    }
    this.sourcePath = checkedRemoteRelativePath(request.source.relativePath)
    this.destination = resolve(request.destination.path)
    const partialName = `.${basename(this.destination)}.phi-transfer-${request.transferId}.part`
    this.partialLocator = join(dirname(this.destination), partialName)
    this.manifestLocator = `${this.partialLocator}.json`
    this.destinationKey = this.destination
  }

  async preflight(signal: AbortSignal): Promise<TransferPreflight> {
    if (signal.aborted) throw transferAbortError()
    if ((await inspectLocalPath(this.destination)).kind !== 'missing') {
      throw new TransferError('DESTINATION_EXISTS', 'Transfer destination already exists')
    }
    const identity = await this.remoteIdentity(signal)
    const filesystem = await statfs(dirname(this.destination))
    const available = Number(filesystem.bavail) * Number(filesystem.bsize)
    this.sourceIdentity = identity
    return {
      sourceIdentity: identity,
      expectedSize: identity.size,
      sourceHashAvailable: true,
      destinationHashAvailable: true,
      destinationAvailableBytes: Number.isSafeInteger(available)
        ? available
        : Number.MAX_SAFE_INTEGER
    }
  }

  inspectSource(): Promise<TransferSourceIdentity> {
    return this.remoteIdentity()
  }

  async loadManifest(): Promise<TransferManifest | null> {
    let handle
    try {
      handle = await open(this.manifestLocator, constants.O_RDONLY | noFollowFlag())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new TransferError('INVALID_MANIFEST', 'Transfer manifest cannot be opened safely')
    }
    try {
      const metadata = await handle.stat()
      const owner = localOwnerId()
      if (
        !metadata.isFile() ||
        metadata.size > MAX_MANIFEST_BYTES ||
        (owner !== null && metadata.uid !== owner)
      ) {
        throw new TransferError(
          'INVALID_MANIFEST',
          'Transfer manifest type, owner, or size is invalid'
        )
      }
      let value: unknown
      try {
        value = JSON.parse(await handle.readFile('utf8'))
      } catch {
        throw new TransferError('INVALID_MANIFEST', 'Transfer manifest JSON is invalid')
      }
      const manifest = parseTransferManifest(value)
      if (!manifest) throw new TransferError('INVALID_MANIFEST', 'Transfer manifest is invalid')
      return manifest
    } finally {
      await handle.close()
    }
  }

  async writeManifest(manifest: TransferManifest): Promise<void> {
    const temporary = `${this.manifestLocator}.${randomUUID()}.tmp`
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600
    )
    try {
      await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8')
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.manifestLocator)
    await syncDirectory(dirname(this.manifestLocator))
  }

  async removeManifest(): Promise<void> {
    await this.unlinkIfPresent(this.manifestLocator)
  }

  inspectPartial(): Promise<PartialInspection> {
    return inspectLocalPath(this.partialLocator)
  }

  async createPartial(): Promise<void> {
    const handle = await open(
      this.partialLocator,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600
    )
    try {
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async truncatePartial(size: number): Promise<void> {
    const handle = await open(this.partialLocator, constants.O_WRONLY | noFollowFlag())
    try {
      const metadata = await handle.stat()
      const owner = localOwnerId()
      if (!metadata.isFile() || (owner !== null && metadata.uid !== owner)) {
        throw new TransferError('INVALID_PARTIAL', 'Transfer partial changed before truncation')
      }
      await handle.truncate(size)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  hashPartialRange(offset: number, size: number, chunkSize: number): Promise<string> {
    return hashLocalFile(this.partialLocator, chunkSize, { offset, size })
  }

  async copy(copyOptions: TransferCopyOptions): Promise<void> {
    const expected = this.sourceIdentity
    if (!expected) throw new Error('Helper transfer preflight has not completed')
    const partial = await open(this.partialLocator, constants.O_RDWR | noFollowFlag())
    let confirmedOffset = copyOptions.offset
    let reconnects = 0
    try {
      while (confirmedOffset < expected.size) {
        const { client, maxWindow } = await this.connect()
        const closeOnAbort = (): void => void client.close().catch(() => undefined)
        copyOptions.signal.addEventListener('abort', closeOnAbort, { once: true })
        try {
          confirmedOffset = await this.copyAttempt(
            client,
            maxWindow,
            partial,
            expected,
            confirmedOffset,
            copyOptions,
            (offset) => {
              confirmedOffset = offset
            }
          )
          await partial.sync()
          await client.request('transfer.close', { transferId: this.request.transferId })
          await client.close().catch(() => undefined)
          break
        } catch (error) {
          await client.close().catch(() => undefined)
          if (copyOptions.signal.aborted) throw transferAbortError()
          if (!this.reconnectable(error) || reconnects >= (this.options.maxReconnects ?? 2)) {
            throw mappedHelperError(error)
          }
          reconnects += 1
        } finally {
          copyOptions.signal.removeEventListener('abort', closeOnAbort)
        }
      }
    } finally {
      await partial.close()
    }
  }

  async hashSource(_chunkSize: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw transferAbortError()
    return checkedHash(await this.rpc('transfer.hash', { path: this.sourcePath }, signal))
  }

  async hashPartial(chunkSize: number, signal?: AbortSignal): Promise<string> {
    this.verifiedPartial = await hashVerifiedLocalFile(this.partialLocator, chunkSize, signal)
    return this.verifiedPartial.sha256
  }

  async publish(): Promise<void> {
    await publishVerifiedLocalFile(this.partialLocator, this.destination, this.verifiedPartial)
    await syncDirectory(dirname(this.destination))
  }

  async discard(): Promise<void> {
    await Promise.all([
      this.unlinkIfPresent(this.partialLocator),
      this.unlinkIfPresent(this.manifestLocator)
    ])
  }

  private async copyAttempt(
    client: HelperDataPlaneProtocolClient,
    maxWindow: number,
    partial: Awaited<ReturnType<typeof open>>,
    expected: TransferSourceIdentity,
    startOffset: number,
    copyOptions: TransferCopyOptions,
    onConfirmed: (offset: number) => void
  ): Promise<number> {
    if (copyOptions.signal.aborted) throw transferAbortError()
    const opened = await client.request<DownloadOpenResult>('transfer.download.open', {
      transferId: this.request.transferId,
      path: this.sourcePath,
      offset: startOffset,
      window: maxWindow
    })
    if (
      opened.offset !== startOffset ||
      !sameSourceIdentity(checkedIdentity(opened.sourceIdentity), expected)
    ) {
      throw new TransferError(
        'SOURCE_CHANGED',
        'Remote transfer source changed before download resumed'
      )
    }
    if (
      opened.chunkSize !== HELPER_DATA_PLANE_CHUNK_BYTES ||
      !Number.isSafeInteger(opened.window) ||
      opened.window < 1 ||
      opened.window > maxWindow
    ) {
      throw new TransferError(
        'TRANSFER_FAILED',
        'Remote helper returned an invalid download stream contract'
      )
    }
    const chunkSize = Math.min(
      HELPER_DATA_PLANE_CHUNK_BYTES,
      Math.max(1, copyOptions.chunkSize),
      opened.chunkSize
    )
    const window = opened.window
    type PendingChunk = Readonly<{
      offset: number
      size: number
      response: ReturnType<typeof client.exchangeBinary>
    }>
    const pending: PendingChunk[] = []
    let requestedOffset = startOffset
    let confirmedOffset = startOffset
    let lastProgress:
      | Readonly<{ offset: number; chunkOffset: number; chunkSize: number; chunkSha256: string }>
      | undefined
    let checkpointOffset = startOffset
    const send = (): void => {
      const size = Math.min(chunkSize, expected.size - requestedOffset)
      const offset = requestedOffset
      requestedOffset += size
      const response = client.exchangeBinary(
        {
          type: HelperBinaryFrameType.DownloadRequest,
          transferId: this.request.transferId,
          offset,
          length: size,
          sha256: Buffer.alloc(32),
          data: Buffer.alloc(0)
        },
        HelperBinaryFrameType.DownloadData
      )
      void response.catch(() => undefined)
      pending.push({ offset, size, response })
    }
    const confirm = async (
      chunk: PendingChunk
    ): Promise<{ progress: TransferProgress; checkpoint: boolean }> => {
      const frame = await chunk.response
      const digest = createHash('sha256').update(frame.data).digest()
      if (
        frame.offset !== chunk.offset ||
        frame.length !== chunk.size ||
        frame.data.byteLength !== chunk.size ||
        !frame.sha256.equals(digest)
      ) {
        throw new TransferError(
          'INVALID_PARTIAL',
          'Remote helper returned an invalid download chunk'
        )
      }
      let written = 0
      while (written < frame.data.byteLength) {
        const result = await partial.write(
          frame.data,
          written,
          frame.data.byteLength - written,
          frame.offset + written
        )
        written += result.bytesWritten
      }
      lastProgress = {
        offset: frame.offset + frame.data.byteLength,
        chunkOffset: frame.offset,
        chunkSize: frame.data.byteLength,
        chunkSha256: digest.toString('hex')
      }
      confirmedOffset = lastProgress.offset
      onConfirmed(confirmedOffset)
      return { progress: lastProgress, checkpoint: await copyOptions.onChunk(lastProgress) }
    }
    while (confirmedOffset < expected.size || pending.length > 0) {
      if (copyOptions.signal.aborted) throw transferAbortError()
      while (requestedOffset < expected.size && pending.length < window) send()
      const first = pending.shift()
      if (!first) break
      let confirmed = await confirm(first)
      if (confirmed.checkpoint) {
        while (pending.length > 0) confirmed = await confirm(pending.shift()!)
        await partial.sync()
        await copyOptions.onCheckpoint(confirmed.progress)
        checkpointOffset = confirmed.progress.offset
      }
    }
    if (lastProgress && lastProgress.offset > checkpointOffset) {
      await partial.sync()
      await copyOptions.onCheckpoint(lastProgress)
    }
    return confirmedOffset
  }

  private async remoteIdentity(signal?: AbortSignal): Promise<TransferSourceIdentity> {
    return checkedIdentity(
      await this.rpc<TransferSourceIdentity>('transfer.identity', { path: this.sourcePath }, signal)
    )
  }

  private async rpc<T = unknown>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<T> {
    const { client } = await this.connect()
    try {
      return await client.request<T>(method, params, { signal })
    } catch (error) {
      throw mappedHelperError(error)
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  private reconnectable(error: unknown): boolean {
    return error instanceof HelperProtocolError && error.domainCode === undefined
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
