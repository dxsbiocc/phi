import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, rename, statfs, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import type {
  PartialInspection,
  TransferCopyOptions,
  TransferDataPlane,
  TransferDataPlaneSession,
  TransferPreflight
} from './data-plane'
import { TransferError } from './errors'
import { parseTransferManifest, type TransferManifest } from './manifest'
import type { TransferRequest, TransferSourceIdentity } from './types'

const MAX_MANIFEST_BYTES = 64 * 1024
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function abortError(): Error {
  const error = new Error('Transfer cancelled')
  error.name = 'AbortError'
  return error
}

async function pathKind(path: string): Promise<PartialInspection> {
  try {
    const metadata = await lstat(path)
    return {
      kind: metadata.isSymbolicLink()
        ? 'symlink'
        : metadata.isFile()
          ? 'file'
          : metadata.isDirectory()
            ? 'directory'
            : 'other',
      size: metadata.size,
      ownerId: typeof metadata.uid === 'number' ? metadata.uid : null
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing', size: 0, ownerId: null }
    }
    throw error
  }
}

async function sourceIdentity(path: string): Promise<TransferSourceIdentity> {
  const metadata = await lstat(path, { bigint: true })
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TransferError('SOURCE_CHANGED', 'Transfer source must be a regular non-symbolic file')
  }
  const size = Number(metadata.size)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TransferError('INVALID_REQUEST', 'Transfer source is too large to represent safely')
  }
  return {
    kind: 'local-file-v1',
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size,
    mtime: metadata.mtimeNs.toString()
  }
}

async function hashFile(
  path: string,
  chunkSize: number,
  range?: Readonly<{ offset: number; size: number }>,
  signal?: AbortSignal
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag())
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.max(1, chunkSize))
  let position = range?.offset ?? 0
  const end = range === undefined ? Number.POSITIVE_INFINITY : range.offset + range.size
  try {
    while (position < end) {
      if (signal?.aborted) throw abortError()
      const length = Math.min(buffer.byteLength, end - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    if (range !== undefined && position !== end) {
      throw new TransferError('INVALID_PARTIAL', 'Partial range is shorter than its manifest')
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
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

class LocalTransferSession implements TransferDataPlaneSession {
  readonly destinationKey: string
  readonly partialLocator: string
  readonly manifestLocator: string

  constructor(
    private readonly sourcePath: string,
    private readonly destinationPath: string,
    transferId: string
  ) {
    const partialName = `.${basename(destinationPath)}.phi-transfer-${transferId}.part`
    this.partialLocator = join(dirname(destinationPath), partialName)
    this.manifestLocator = `${this.partialLocator}.json`
    this.destinationKey = resolve(destinationPath)
  }

  async preflight(signal: AbortSignal): Promise<TransferPreflight> {
    if (signal.aborted) throw abortError()
    const destination = await pathKind(this.destinationPath)
    if (destination.kind !== 'missing') {
      throw new TransferError('DESTINATION_EXISTS', 'Transfer destination already exists')
    }
    const identity = await sourceIdentity(this.sourcePath)
    const filesystem = await statfs(dirname(this.destinationPath))
    const available = Number(filesystem.bavail) * Number(filesystem.bsize)
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
    return sourceIdentity(this.sourcePath)
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
      const owner = typeof process.getuid === 'function' ? process.getuid() : null
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
    return pathKind(this.partialLocator)
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
      const owner = typeof process.getuid === 'function' ? process.getuid() : null
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
    return hashFile(this.partialLocator, chunkSize, { offset, size })
  }

  async copy(options: TransferCopyOptions): Promise<void> {
    const source = await open(this.sourcePath, constants.O_RDONLY | noFollowFlag())
    const partial = await open(this.partialLocator, constants.O_RDWR | noFollowFlag())
    const buffer = Buffer.allocUnsafe(options.chunkSize)
    let position = options.offset
    let lastCheckpoint = options.offset
    try {
      while (true) {
        if (options.signal.aborted) throw abortError()
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position)
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) {
          const result = await partial.write(
            buffer,
            written,
            bytesRead - written,
            position + written
          )
          written += result.bytesWritten
        }
        const progress = {
          offset: position + bytesRead,
          chunkOffset: position,
          chunkSize: bytesRead,
          chunkSha256: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
        }
        position = progress.offset
        if (await options.onChunk(progress)) {
          await partial.sync()
          await options.onCheckpoint(progress)
          lastCheckpoint = progress.offset
        }
      }
      await partial.sync()
      if (position > lastCheckpoint) {
        const lastSize = Math.min(options.chunkSize, position)
        const lastOffset = position - lastSize
        await options.onCheckpoint({
          offset: position,
          chunkOffset: lastOffset,
          chunkSize: lastSize,
          chunkSha256: await this.hashPartialRange(lastOffset, lastSize, options.chunkSize)
        })
      }
    } finally {
      await Promise.allSettled([source.close(), partial.close()])
    }
  }

  hashSource(chunkSize: number, signal?: AbortSignal): Promise<string> {
    return hashFile(this.sourcePath, chunkSize, undefined, signal)
  }

  hashPartial(chunkSize: number, signal?: AbortSignal): Promise<string> {
    return hashFile(this.partialLocator, chunkSize, undefined, signal)
  }

  async publish(): Promise<void> {
    const partial = await pathKind(this.partialLocator)
    if (partial.kind !== 'file') {
      throw new TransferError('INVALID_PARTIAL', 'Transfer partial is not a regular file')
    }
    try {
      await link(this.partialLocator, this.destinationPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new TransferError(
          'DESTINATION_EXISTS',
          'Transfer destination appeared before publish'
        )
      }
      throw error
    }
    await unlink(this.partialLocator)
    await syncDirectory(dirname(this.destinationPath))
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

export class LocalTransferDataPlane implements TransferDataPlane {
  readonly id = 'local'

  destinationKey(request: TransferRequest): string {
    if (request.destination.kind !== 'local-path') return `unsupported:${request.transferId}`
    return resolve(request.destination.path)
  }

  async open(request: TransferRequest): Promise<TransferDataPlaneSession> {
    if (!ID_PATTERN.test(request.transferId)) {
      throw new TransferError('INVALID_REQUEST', 'Transfer id is invalid')
    }
    if (request.source.kind !== 'local-path' || request.destination.kind !== 'local-path') {
      throw new TransferError('INVALID_REQUEST', 'Local data plane requires local path endpoints')
    }
    if (!isAbsolute(request.source.path) || !isAbsolute(request.destination.path)) {
      throw new TransferError('INVALID_REQUEST', 'Local transfer endpoints must be absolute')
    }
    if (request.expectedSha256 !== undefined && !SHA256_PATTERN.test(request.expectedSha256)) {
      throw new TransferError('INVALID_REQUEST', 'Expected SHA-256 is invalid')
    }
    return new LocalTransferSession(
      request.source.path,
      request.destination.path,
      request.transferId
    )
  }
}
