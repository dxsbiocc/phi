import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { posix } from 'node:path'

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
import { parseTransferManifest, type TransferManifest } from './manifest'
import {
  hashLocalFile,
  localOwnerId,
  localSourceIdentity,
  transferAbortError
} from './ssh-data-plane-local'
import type { TransferProgress, TransferRequest, TransferSourceIdentity } from './types'

const MAX_MANIFEST_BYTES = 64 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type TransferInspection = Readonly<{
  kind: 'missing' | 'file' | 'directory' | 'symlink' | 'other'
  size: number
  availableBytes?: number
}>

type HashResult = Readonly<{ hash: string }>

type UploadPaths = Readonly<{
  destination: string
  partial: string
  manifest: string
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

function uploadPaths(relativePath: string, transferId: string): UploadPaths {
  const destination = checkedRemoteRelativePath(relativePath)
  const directory = posix.dirname(destination)
  const partial = posix.join(
    directory,
    `.${posix.basename(destination)}.phi-transfer-${transferId}.part`
  )
  return { destination, partial, manifest: `${partial}.json` }
}

function decodeManifest(content: string): TransferManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(content, 'base64').toString('utf8'))
  } catch {
    throw new TransferError('INVALID_MANIFEST', 'Remote transfer manifest JSON is invalid')
  }
  const manifest = parseTransferManifest(parsed)
  if (!manifest) throw new TransferError('INVALID_MANIFEST', 'Remote transfer manifest is invalid')
  return manifest
}

function checkedHash(result: HashResult): string {
  if (!SHA256_PATTERN.test(result.hash)) {
    throw new TransferError('TRANSFER_FAILED', 'Remote helper returned an invalid SHA-256')
  }
  return result.hash
}

function mappedHelperError(error: unknown): unknown {
  if (!(error instanceof HelperProtocolError) || !error.domainCode) return error
  switch (error.domainCode) {
    case 'DESTINATION_EXISTS':
      return new TransferError('DESTINATION_EXISTS', error.message)
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

export class HelperUploadSession implements TransferDataPlaneSession {
  readonly destinationKey: string
  readonly partialLocator: string
  readonly manifestLocator: string
  private sourceIdentity?: TransferSourceIdentity
  private partialHash?: string

  constructor(
    private readonly request: TransferRequest,
    private readonly options: HelperTransferDataPlaneOptions,
    private readonly connect: () => Promise<NegotiatedHelperConnection>
  ) {
    if (
      request.source.kind !== 'local-path' ||
      request.destination.kind !== 'remote-workspace-path' ||
      request.destination.hostId !== options.hostId ||
      request.destination.workspaceId !== options.workspaceId
    ) {
      throw new TransferError(
        'INVALID_REQUEST',
        'Helper upload requires authorized local-to-workspace endpoints'
      )
    }
    const paths = uploadPaths(request.destination.relativePath, request.transferId)
    this.paths = paths
    this.sourcePath = request.source.path
    this.destinationKey = `helper:${options.hostId}:${options.workspaceId}:${paths.destination}`
    this.partialLocator = `ssh://${options.hostId}/${options.workspaceId}/${paths.partial}`
    this.manifestLocator = `ssh://${options.hostId}/${options.workspaceId}/${paths.manifest}`
  }

  private readonly paths: UploadPaths
  private readonly sourcePath: string

  async preflight(signal: AbortSignal): Promise<TransferPreflight> {
    if (signal.aborted) throw transferAbortError()
    const identity = await localSourceIdentity(this.sourcePath)
    const [inspection, destination] = await Promise.all([
      this.rpc<TransferInspection>('transfer.inspect', { path: this.paths.partial }, signal),
      this.rpc<TransferInspection>('transfer.inspect', { path: this.paths.destination }, signal)
    ])
    if (destination.kind !== 'missing') {
      throw new TransferError('DESTINATION_EXISTS', 'Transfer destination already exists')
    }
    this.sourceIdentity = identity
    return {
      sourceIdentity: identity,
      expectedSize: identity.size,
      sourceHashAvailable: true,
      destinationHashAvailable: true,
      destinationAvailableBytes:
        Number.isSafeInteger(inspection.availableBytes) && inspection.availableBytes! >= 0
          ? inspection.availableBytes!
          : Number.MAX_SAFE_INTEGER
    }
  }

  inspectSource(): Promise<TransferSourceIdentity> {
    return localSourceIdentity(this.sourcePath)
  }

  async loadManifest(): Promise<TransferManifest | null> {
    const inspection = await this.inspect(this.paths.manifest)
    if (inspection.kind === 'missing') return null
    if (inspection.kind !== 'file' || inspection.size > MAX_MANIFEST_BYTES) {
      throw new TransferError(
        'INVALID_MANIFEST',
        'Remote transfer manifest is not a bounded regular file'
      )
    }
    const result = await this.rpc<{ content: string; bytesRead: number; eof: boolean }>(
      'fs.readRange',
      { path: this.paths.manifest, offset: 0, length: MAX_MANIFEST_BYTES }
    )
    if (!result.eof || result.bytesRead !== inspection.size) {
      throw new TransferError('INVALID_MANIFEST', 'Remote transfer manifest changed while reading')
    }
    return decodeManifest(result.content)
  }

  async writeManifest(manifest: TransferManifest): Promise<void> {
    const content = Buffer.from(`${JSON.stringify(manifest)}\n`).toString('base64')
    await this.rpc('fs.writeAtomic', { path: this.paths.manifest, content })
  }

  async removeManifest(): Promise<void> {
    await this.rpc('transfer.remove', { path: this.paths.manifest })
  }

  async inspectPartial(): Promise<PartialInspection> {
    const inspection = await this.inspect(this.paths.partial)
    return {
      kind: inspection.kind,
      size: inspection.size,
      // Go has already verified the remote UID. The manager compares this adapter value with
      // the desktop UID, so map a verified remote owner to the local ownership sentinel.
      ownerId: inspection.kind === 'file' ? localOwnerId() : null
    }
  }

  async createPartial(): Promise<void> {
    await this.rpc('transfer.create', { path: this.paths.partial })
  }

  async truncatePartial(size: number): Promise<void> {
    await this.rpc('transfer.truncate', { path: this.paths.partial, size })
  }

  async hashPartialRange(offset: number, size: number): Promise<string> {
    return checkedHash(
      await this.rpc<HashResult>('transfer.hash', {
        path: this.paths.partial,
        offset,
        length: size
      })
    )
  }

  async copy(copyOptions: TransferCopyOptions): Promise<void> {
    if (copyOptions.signal.aborted) throw transferAbortError()
    const chunkSize = Math.min(HELPER_DATA_PLANE_CHUNK_BYTES, Math.max(1, copyOptions.chunkSize))
    const source = await open(this.sourcePath, constants.O_RDONLY | noFollowFlag())
    let confirmedOffset = copyOptions.offset
    let reconnects = 0
    try {
      while (true) {
        const { client, maxWindow } = await this.connect()
        const closeOnAbort = (): void => void client.close().catch(() => undefined)
        copyOptions.signal.addEventListener('abort', closeOnAbort, { once: true })
        try {
          const inspection = await client.request<TransferInspection>('transfer.inspect', {
            path: this.paths.partial
          })
          if (inspection.kind !== 'file' || inspection.size < confirmedOffset) {
            throw new TransferError(
              'INVALID_PARTIAL',
              'Remote helper partial is shorter than the last acknowledged offset'
            )
          }
          if (inspection.size > confirmedOffset) {
            await client.request('transfer.truncate', {
              path: this.paths.partial,
              size: confirmedOffset
            })
          }
          confirmedOffset = await this.copyAttempt(
            client,
            maxWindow,
            source,
            confirmedOffset,
            chunkSize,
            copyOptions,
            (offset) => {
              confirmedOffset = offset
            }
          )
          await client.request('transfer.sync', { path: this.paths.partial })
          await client.request('transfer.close', { transferId: this.request.transferId })
          await client.close().catch(() => undefined)
          return
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
      await source.close()
    }
  }

  private async copyAttempt(
    client: HelperDataPlaneProtocolClient,
    maxWindow: number,
    source: Awaited<ReturnType<typeof open>>,
    startOffset: number,
    chunkSize: number,
    copyOptions: TransferCopyOptions,
    onConfirmed: (offset: number) => void
  ): Promise<number> {
    const opened = await client.request<{ offset: number; chunkSize: number; window: number }>(
      'transfer.upload.open',
      {
        transferId: this.request.transferId,
        path: this.paths.partial,
        offset: startOffset,
        window: maxWindow
      }
    )
    if (
      opened.offset !== startOffset ||
      opened.chunkSize !== HELPER_DATA_PLANE_CHUNK_BYTES ||
      !Number.isSafeInteger(opened.window) ||
      opened.window < 1 ||
      opened.window > maxWindow
    ) {
      throw new TransferError(
        'TRANSFER_FAILED',
        'Remote helper returned an invalid upload stream contract'
      )
    }
    const window = opened.window
    type PendingChunk = Readonly<{
      offset: number
      size: number
      digest: Buffer
      response: ReturnType<typeof client.exchangeBinary>
    }>
    const pending: PendingChunk[] = []
    let position = startOffset
    let confirmedOffset = startOffset
    let sourceEnded = false
    let lastProgress: TransferProgress | undefined
    let checkpointOffset = startOffset
    const send = async (): Promise<void> => {
      const data = Buffer.allocUnsafe(chunkSize)
      const { bytesRead } = await source.read(data, 0, data.byteLength, position)
      if (bytesRead === 0) {
        sourceEnded = true
        return
      }
      const content = bytesRead === data.byteLength ? data : data.subarray(0, bytesRead)
      const digest = createHash('sha256').update(content).digest()
      const offset = position
      position += content.byteLength
      const response = client.exchangeBinary(
        {
          type: HelperBinaryFrameType.UploadData,
          transferId: this.request.transferId,
          offset,
          length: content.byteLength,
          sha256: digest,
          data: content
        },
        HelperBinaryFrameType.UploadAck
      )
      void response.catch(() => undefined)
      pending.push({ offset, size: content.byteLength, digest, response })
    }
    const confirm = async (
      chunk: PendingChunk
    ): Promise<{ progress: TransferProgress; checkpoint: boolean }> => {
      const ack = await chunk.response
      if (
        ack.offset !== chunk.offset ||
        ack.length !== chunk.size ||
        !ack.sha256.equals(chunk.digest)
      ) {
        throw new TransferError(
          'INVALID_PARTIAL',
          'Remote helper acknowledged an unexpected upload offset'
        )
      }
      const progress = {
        offset: chunk.offset + chunk.size,
        chunkOffset: chunk.offset,
        chunkSize: chunk.size,
        chunkSha256: chunk.digest.toString('hex')
      }
      lastProgress = progress
      confirmedOffset = progress.offset
      onConfirmed(confirmedOffset)
      return { progress, checkpoint: await copyOptions.onChunk(progress) }
    }
    while (!sourceEnded || pending.length > 0) {
      if (copyOptions.signal.aborted) throw transferAbortError()
      while (!sourceEnded && pending.length < window) await send()
      const first = pending.shift()
      if (!first) continue
      let confirmed = await confirm(first)
      if (confirmed.checkpoint) {
        while (pending.length > 0) confirmed = await confirm(pending.shift()!)
        await client.request('transfer.sync', { path: this.paths.partial })
        await copyOptions.onCheckpoint(confirmed.progress)
        checkpointOffset = confirmed.progress.offset
      }
    }
    if (lastProgress && lastProgress.offset > checkpointOffset) {
      await client.request('transfer.sync', { path: this.paths.partial })
      await copyOptions.onCheckpoint(lastProgress)
    }
    return confirmedOffset
  }

  private reconnectable(error: unknown): boolean {
    return error instanceof HelperProtocolError && error.domainCode === undefined
  }

  hashSource(chunkSize: number, signal?: AbortSignal): Promise<string> {
    return hashLocalFile(this.sourcePath, chunkSize, undefined, signal)
  }

  async hashPartial(_chunkSize: number, signal?: AbortSignal): Promise<string> {
    const hash = checkedHash(
      await this.rpc<HashResult>('transfer.hash', { path: this.paths.partial }, signal)
    )
    this.partialHash = hash
    return hash
  }

  async publish(): Promise<void> {
    const identity = this.sourceIdentity
    const hash = this.partialHash
    if (!identity || !hash) throw new Error('Helper transfer has not been verified')
    await this.rpc('transfer.publish', {
      partialPath: this.paths.partial,
      destinationPath: this.paths.destination,
      expectedSize: identity.size,
      expectedSha256: hash,
      overwrite: false
    })
  }

  async discard(): Promise<void> {
    await this.rpc('transfer.remove', { path: this.paths.partial })
    await this.rpc('transfer.remove', { path: this.paths.manifest })
  }

  private inspect(path: string): Promise<TransferInspection> {
    return this.rpc<TransferInspection>('transfer.inspect', { path })
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
}
