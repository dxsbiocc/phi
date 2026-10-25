import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

import type { SessionAdoptParams } from '../../shared/kernel-protocol/history'

const MAX_HEADER_BYTES = 64 * 1024
const READ_BUFFER_BYTES = 256 * 1024

export type OmpJournalHeader = {
  type: 'session'
  version: number
  id: string
  timestamp: string
  cwd: string
}

export type AdoptionSourceInspection = {
  path: string
  size: number
  mtime: string
  sha256: string
  header: OmpJournalHeader
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function journalHeader(value: Record<string, unknown> | undefined): OmpJournalHeader | undefined {
  if (value?.type !== 'session') return undefined
  if (!Number.isInteger(value.version) || (value.version as number) < 1) return undefined
  if (typeof value.id !== 'string' || !value.id) return undefined
  if (!validIso(value.timestamp)) return undefined
  if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) return undefined
  return {
    type: 'session',
    version: value.version as number,
    id: value.id,
    timestamp: value.timestamp,
    cwd: value.cwd
  }
}

function parseHeader(prefix: string): OmpJournalHeader {
  if (!prefix.trim() || (!prefix.includes('\n') && Buffer.byteLength(prefix) >= MAX_HEADER_BYTES)) {
    throw new Error('source journal header is missing or exceeds its size limit')
  }
  for (const line of prefix.split('\n')) {
    if (!line.trim()) continue
    let value: Record<string, unknown> | undefined
    try {
      value = record(JSON.parse(line))
    } catch {
      value = undefined
    }
    // Current journals have a fixed-width title slot before the immutable
    // header; older current-format journals begin directly with the header.
    if (value?.type === 'title') continue
    const header = journalHeader(value)
    if (!header) break
    return header
  }
  throw new Error('source is not an OMP journal with a valid session header')
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

async function assertAllowedSource(path: string, allowedRoots: readonly string[]): Promise<string> {
  if (!isAbsolute(path)) throw new Error('source journal path must be absolute')
  if (allowedRoots.length === 0) throw new Error('at least one allowed source root is required')
  const sourceInfo = await lstat(path)
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error('source journal must be a regular file and not a symlink')
  }
  const sourceRealPath = await realpath(path)
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)))
  const rootInfos = await Promise.all(roots.map((root) => lstat(root)))
  if (rootInfos.some((info) => !info.isDirectory())) {
    throw new Error('allowed source roots must be directories')
  }
  if (!roots.some((root) => inside(root, sourceRealPath))) {
    throw new Error('source journal is outside the allowed roots')
  }
  return sourceRealPath
}

export async function readAndHashJournal(path: string): Promise<AdoptionSourceInspection> {
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('source journal must be a regular file')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(READ_BUFFER_BYTES)
    const headerChunks: Buffer[] = []
    let headerBytes = 0
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (headerBytes < MAX_HEADER_BYTES) {
        const prefix = chunk.subarray(0, MAX_HEADER_BYTES - headerBytes)
        headerChunks.push(Buffer.from(prefix))
        headerBytes += prefix.length
      }
      position += bytesRead
    }
    const after = await handle.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      position !== before.size
    ) {
      throw new Error('source journal changed while it was being inspected')
    }
    return {
      path,
      size: before.size,
      mtime: before.mtime.toISOString(),
      sha256: hash.digest('hex'),
      header: parseHeader(Buffer.concat(headerChunks).toString('utf8'))
    }
  } finally {
    await handle.close()
  }
}

export async function inspectAdoptionSource(
  params: SessionAdoptParams,
  allowedRoots: readonly string[]
): Promise<AdoptionSourceInspection> {
  const sourcePath = await assertAllowedSource(params.source.path, allowedRoots)
  const source = await readAndHashJournal(sourcePath)
  if (source.header.cwd !== params.source.cwd) {
    throw new Error('source journal cwd does not match the requested cwd')
  }
  if (params.source.expected?.size !== undefined && params.source.expected.size !== source.size) {
    throw new Error('source journal size does not match the expected size')
  }
  if (
    params.source.expected?.sha256 !== undefined &&
    params.source.expected.sha256 !== source.sha256
  ) {
    throw new Error('source journal hash does not match the expected hash')
  }
  return source
}
