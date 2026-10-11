import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, statfs, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Readable } from 'node:stream'

import type {
  PartialInspection,
  TransferCopyOptions,
  TransferDataPlaneSession,
  TransferPreflight
} from './data-plane'
import { TransferError } from './errors'
import { parseTransferManifest, type TransferManifest } from './manifest'
import {
  hashLocalFile,
  hashVerifiedLocalFile,
  inspectLocalPath,
  localOwnerId,
  publishVerifiedLocalFile,
  type VerifiedLocalFile,
  transferAbortError
} from './ssh-data-plane-local'
import {
  buildDownloadPreflightScript,
  buildDownloadHashScript,
  buildDownloadStreamScript,
  shellScriptCommand,
  type RemoteHashTool
} from './ssh-data-plane-scripts'
import type { SshTransferDataPlaneOptions } from './ssh-data-plane'
import type { TransferRequest, TransferSourceIdentity } from './types'

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_CONTROL_OUTPUT_BYTES = 64 * 1024
const DEFAULT_CONTROL_TIMEOUT_MS = 30 * 60 * 1000
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type RemoteSourceState = Readonly<{
  identity: TransferSourceIdentity
  hashTool: RemoteHashTool
}>

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function lineValue(output: string, key: string): string | null {
  const prefix = `${key}=`
  const line = output.split('\n').find((candidate) => candidate.startsWith(prefix))
  return line?.slice(prefix.length) ?? null
}

function mappedError(output: string, fallback: string): TransferError {
  switch (lineValue(output, 'PHI_ERROR')) {
    case 'HASH_UNAVAILABLE':
      return new TransferError(
        'HASH_UNAVAILABLE',
        'Remote SHA-256 verification is unavailable; size-only verification is forbidden'
      )
    case 'SOURCE_CHANGED':
      return new TransferError('SOURCE_CHANGED', 'Remote transfer source changed')
    default:
      return new TransferError('TRANSFER_FAILED', fallback)
  }
}

function parseIdentity(value: string | null): TransferSourceIdentity {
  const fields = value?.split('|') ?? []
  const size = Number(fields[2])
  if (
    fields.length !== 4 ||
    !fields[0] ||
    !fields[1] ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !fields[3]
  ) {
    throw new TransferError('TRANSFER_FAILED', 'Remote source identity response is invalid')
  }
  return {
    kind: 'ssh-file-v1',
    device: fields[0],
    inode: fields[1],
    size,
    mtime: fields[3]
  }
}

function captureText(stream: Readable, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    stream.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const kept = chunk.subarray(0, Math.max(0, limit - bytes))
      if (kept.byteLength > 0) chunks.push(kept)
      bytes += kept.byteLength
    })
    stream.once('error', reject)
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class SshDownloadSession implements TransferDataPlaneSession {
  readonly destinationKey: string
  readonly partialLocator: string
  readonly manifestLocator: string
  private readonly source: string
  private readonly sourceParent: string
  private readonly destination: string
  private sourceState?: RemoteSourceState
  private verifiedPartial?: VerifiedLocalFile

  constructor(
    request: TransferRequest,
    sourceRelative: string,
    destination: string,
    private readonly options: SshTransferDataPlaneOptions
  ) {
    this.source = joinPosix(options.canonicalRoot, sourceRelative)
    this.sourceParent = this.source.slice(0, this.source.lastIndexOf('/')) || '/'
    this.destination = destination
    const partialName = `.${basename(destination)}.phi-transfer-${request.transferId}.part`
    this.partialLocator = join(dirname(destination), partialName)
    this.manifestLocator = `${this.partialLocator}.json`
    this.destinationKey = destination
  }

  async preflight(signal: AbortSignal): Promise<TransferPreflight> {
    if (signal.aborted) throw transferAbortError()
    const destination = await inspectLocalPath(this.destination)
    if (destination.kind !== 'missing') {
      throw new TransferError('DESTINATION_EXISTS', 'Transfer destination already exists')
    }
    const result = await this.options.host.exec.run(
      [
        'sh',
        '-c',
        buildDownloadPreflightScript({
          source: this.source,
          parent: this.sourceParent,
          canonicalRoot: this.options.canonicalRoot
        })
      ],
      {
        cwd: '.',
        timeoutMs: this.options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
        maxOutputBytes: MAX_CONTROL_OUTPUT_BYTES,
        signal
      }
    )
    if (result.code !== 0) throw mappedError(result.stdout, 'Remote download preflight failed')
    const hashTool = lineValue(result.stdout, 'PHI_HASH')
    if (!['sha256sum', 'shasum', 'openssl', 'perl'].includes(hashTool ?? '')) {
      throw new TransferError(
        'HASH_UNAVAILABLE',
        'Remote SHA-256 verification is unavailable; size-only verification is forbidden'
      )
    }
    const identity = parseIdentity(lineValue(result.stdout, 'PHI_ID'))
    const filesystem = await statfs(dirname(this.destination))
    const available = Number(filesystem.bavail) * Number(filesystem.bsize)
    this.sourceState = { identity, hashTool: hashTool as RemoteHashTool }
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

  async inspectSource(): Promise<TransferSourceIdentity> {
    if (!this.sourceState) throw new Error('SSH transfer preflight has not completed')
    const result = await this.options.host.exec.run(
      [
        'sh',
        '-c',
        buildDownloadPreflightScript({
          source: this.source,
          parent: this.sourceParent,
          canonicalRoot: this.options.canonicalRoot
        })
      ],
      {
        cwd: '.',
        timeoutMs: this.options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
        maxOutputBytes: MAX_CONTROL_OUTPUT_BYTES
      }
    )
    if (result.code !== 0) throw mappedError(result.stdout, 'Remote source inspection failed')
    const identity = parseIdentity(lineValue(result.stdout, 'PHI_ID'))
    return identity
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
      const parsed = parseTransferManifest(value)
      if (parsed === null) {
        throw new TransferError('INVALID_MANIFEST', 'Transfer manifest is invalid')
      }
      return parsed
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
    try {
      await unlink(this.manifestLocator)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
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
    const source = this.sourceState
    if (!source) throw new Error('SSH transfer preflight has not completed')
    if (copyOptions.signal.aborted) throw transferAbortError()
    const channel = await this.options.openStream(
      shellScriptCommand(
        buildDownloadStreamScript({
          source: this.source,
          sourceParent: this.sourceParent,
          canonicalRoot: this.options.canonicalRoot,
          offset: copyOptions.offset,
          hashTool: source.hashTool
        })
      )
    )
    channel.stdin.end()
    const stderr = captureText(channel.stderr)
    const closeOnAbort = (): void => void channel.close()
    copyOptions.signal.addEventListener('abort', closeOnAbort, { once: true })
    const partial = await open(this.partialLocator, constants.O_RDWR | noFollowFlag())
    const chunk = Buffer.allocUnsafe(Math.max(1, copyOptions.chunkSize))
    let chunkBytes = 0
    let position = copyOptions.offset
    let lastCheckpoint = position
    const flush = async (): Promise<void> => {
      if (chunkBytes === 0) return
      let written = 0
      while (written < chunkBytes) {
        const result = await partial.write(chunk, written, chunkBytes - written, position + written)
        written += result.bytesWritten
      }
      const progress = {
        offset: position + chunkBytes,
        chunkOffset: position,
        chunkSize: chunkBytes,
        chunkSha256: createHash('sha256').update(chunk.subarray(0, chunkBytes)).digest('hex')
      }
      position = progress.offset
      chunkBytes = 0
      if (await copyOptions.onChunk(progress)) {
        await partial.sync()
        await copyOptions.onCheckpoint(progress)
        lastCheckpoint = progress.offset
      }
      if (copyOptions.signal.aborted) throw transferAbortError()
    }
    try {
      for await (const value of channel.stdout) {
        const input = Buffer.isBuffer(value) ? value : Buffer.from(value)
        let consumed = 0
        while (consumed < input.byteLength) {
          const copied = input.copy(
            chunk,
            chunkBytes,
            consumed,
            consumed + Math.min(chunk.byteLength - chunkBytes, input.byteLength - consumed)
          )
          chunkBytes += copied
          consumed += copied
          if (chunkBytes === chunk.byteLength) await flush()
        }
      }
      await flush()
      await partial.sync()
      const closed = await channel.closed
      const metadata = await stderr
      if (closed.code !== 0) throw mappedError(metadata, 'Remote download stream failed')
      const digest = lineValue(metadata, 'PHI_HASH')
      const before = parseIdentity(lineValue(metadata, 'PHI_BEFORE'))
      const after = parseIdentity(lineValue(metadata, 'PHI_AFTER'))
      if (!digest || !SHA256_PATTERN.test(digest) || !sameIdentity(before, after)) {
        throw new TransferError('SOURCE_CHANGED', 'Remote transfer source changed during download')
      }
      if (position > lastCheckpoint) {
        const lastSize = Math.min(copyOptions.chunkSize, position)
        const lastOffset = position - lastSize
        await copyOptions.onCheckpoint({
          offset: position,
          chunkOffset: lastOffset,
          chunkSize: lastSize,
          chunkSha256: await hashLocalFile(this.partialLocator, copyOptions.chunkSize, {
            offset: lastOffset,
            size: lastSize
          })
        })
      }
    } catch (error) {
      await channel.close().catch(() => undefined)
      if (copyOptions.signal.aborted) throw transferAbortError()
      throw error
    } finally {
      copyOptions.signal.removeEventListener('abort', closeOnAbort)
      await partial.close()
    }
  }

  async hashSource(_chunkSize: number, signal?: AbortSignal): Promise<string> {
    const source = this.sourceState
    if (!source) throw new Error('SSH transfer preflight has not completed')
    const result = await this.options.host.exec.run(
      [
        'sh',
        '-c',
        buildDownloadHashScript({
          source: this.source,
          sourceParent: this.sourceParent,
          canonicalRoot: this.options.canonicalRoot,
          hashTool: source.hashTool
        })
      ],
      {
        cwd: '.',
        timeoutMs: this.options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
        maxOutputBytes: MAX_CONTROL_OUTPUT_BYTES,
        signal
      }
    )
    if (result.code !== 0) throw mappedError(result.stdout, 'Remote source hash failed')
    const digest = lineValue(result.stdout, 'PHI_HASH')
    const before = parseIdentity(lineValue(result.stdout, 'PHI_BEFORE'))
    const after = parseIdentity(lineValue(result.stdout, 'PHI_AFTER'))
    if (!digest || !SHA256_PATTERN.test(digest) || !sameIdentity(before, after)) {
      throw new TransferError('SOURCE_CHANGED', 'Remote transfer source changed during hashing')
    }
    return digest
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
    await Promise.all(
      [this.partialLocator, this.manifestLocator].map(async (path) => {
        try {
          await unlink(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      })
    )
  }
}

function sameIdentity(left: TransferSourceIdentity, right: TransferSourceIdentity): boolean {
  return (
    left.kind === right.kind &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtime === right.mtime
  )
}

function joinPosix(root: string, relative: string): string {
  return `${root}/${relative}`.replace(/\/{2,}/g, '/')
}
