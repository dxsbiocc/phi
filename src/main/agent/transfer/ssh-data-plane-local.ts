import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'

import type { PartialInspection } from './data-plane'
import { TransferError } from './errors'
import type { TransferSourceIdentity } from './types'

export function transferAbortError(): Error {
  const error = new Error('Transfer cancelled')
  error.name = 'AbortError'
  return error
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

export async function inspectLocalPath(path: string): Promise<PartialInspection> {
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

export async function localSourceIdentity(path: string): Promise<TransferSourceIdentity> {
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

export async function hashLocalFile(
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
      if (signal?.aborted) throw transferAbortError()
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

export type VerifiedLocalFile = Readonly<{
  device: string
  inode: string
  size: number
  mtimeNs: string
  ownerId: number | null
  mode: number
  chunkSize: number
  sha256: string
}>

function verifiedMetadata(metadata: BigIntStats): Omit<VerifiedLocalFile, 'sha256' | 'chunkSize'> {
  const owner = localOwnerId()
  const size = Number(metadata.size)
  if (
    !metadata.isFile() ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    metadata.nlink !== 1n ||
    (owner !== null && metadata.uid !== BigInt(owner)) ||
    (Number(metadata.mode) & 0o777) !== 0o600
  ) {
    throw new TransferError('INVALID_PARTIAL', 'Transfer partial identity is unsafe')
  }
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size,
    mtimeNs: metadata.mtimeNs.toString(),
    ownerId: owner,
    mode: Number(metadata.mode) & 0o777
  }
}

function sameVerifiedFile(
  metadata: BigIntStats,
  expected: VerifiedLocalFile,
  allowLinked: boolean
): boolean {
  return (
    metadata.isFile() &&
    metadata.dev.toString() === expected.device &&
    metadata.ino.toString() === expected.inode &&
    Number(metadata.size) === expected.size &&
    metadata.mtimeNs.toString() === expected.mtimeNs &&
    (expected.ownerId === null || metadata.uid === BigInt(expected.ownerId)) &&
    (Number(metadata.mode) & 0o777) === expected.mode &&
    (allowLinked ? metadata.nlink >= 1n : metadata.nlink === 1n)
  )
}

export async function hashVerifiedLocalFile(
  path: string,
  chunkSize: number,
  signal?: AbortSignal
): Promise<VerifiedLocalFile> {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag())
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.max(1, chunkSize))
  let position = 0
  try {
    const before = await handle.stat({ bigint: true })
    const identity = verifiedMetadata(before)
    while (position < identity.size) {
      if (signal?.aborted) throw transferAbortError()
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, identity.size - position),
        position
      )
      if (bytesRead <= 0)
        throw new TransferError('INVALID_PARTIAL', 'Transfer partial changed while hashing')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const sha256 = hash.digest('hex')
    const verified = { ...identity, chunkSize, sha256 }
    if (!sameVerifiedFile(after, verified, false)) {
      throw new TransferError('INVALID_PARTIAL', 'Transfer partial changed while hashing')
    }
    return verified
  } finally {
    await handle.close()
  }
}

export async function publishVerifiedLocalFile(
  partial: string,
  destination: string,
  verified: VerifiedLocalFile | undefined
): Promise<void> {
  if (!verified) throw new TransferError('INVALID_PARTIAL', 'Transfer partial was not verified')
  const reverified = await hashVerifiedLocalFile(partial, verified.chunkSize)
  if (
    reverified.sha256 !== verified.sha256 ||
    reverified.device !== verified.device ||
    reverified.inode !== verified.inode ||
    reverified.mtimeNs !== verified.mtimeNs
  ) {
    throw new TransferError('INVALID_PARTIAL', 'Transfer partial changed before publish')
  }
  const handle = await open(partial, constants.O_RDONLY | noFollowFlag())
  try {
    if (!sameVerifiedFile(await handle.stat({ bigint: true }), verified, false)) {
      throw new TransferError('INVALID_PARTIAL', 'Transfer partial changed before publish')
    }
  } finally {
    await handle.close()
  }
  try {
    await link(partial, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new TransferError('DESTINATION_EXISTS', 'Transfer destination appeared before publish')
    }
    throw error
  }
  const published = await lstat(destination, { bigint: true })
  if (!sameVerifiedFile(published, verified, true)) {
    const current = await lstat(destination, { bigint: true }).catch(() => null)
    if (current && current.dev === published.dev && current.ino === published.ino) {
      await unlink(destination).catch(() => undefined)
    }
    throw new TransferError('INVALID_PARTIAL', 'Published transfer is not the verified partial')
  }
  const currentPartial = await lstat(partial, { bigint: true }).catch(() => null)
  if (currentPartial && sameVerifiedFile(currentPartial, verified, true)) await unlink(partial)
}

export function localOwnerId(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}
