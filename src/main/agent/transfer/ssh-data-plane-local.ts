import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

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

export function localOwnerId(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}
