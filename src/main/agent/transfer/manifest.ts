import type { TransferDirection, TransferSourceIdentity } from './types'

export const TRANSFER_MANIFEST_VERSION = 1 as const

export type TransferManifest = Readonly<{
  protocolVersion: typeof TRANSFER_MANIFEST_VERSION
  transferId: string
  direction: TransferDirection
  sourceIdentity: TransferSourceIdentity
  expectedSize: number
  expectedSha256?: string
  durableOffset: number
  chunkSize: number
  lastChunk: Readonly<{ offset: number; size: number; sha256: string }> | null
  createdAt: number
  updatedAt: number
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseTransferManifest(value: unknown): TransferManifest | null {
  if (!isRecord(value) || value.protocolVersion !== TRANSFER_MANIFEST_VERSION) return null
  if (typeof value.transferId !== 'string') return null
  if (!['upload', 'download', 'local'].includes(String(value.direction))) return null
  if (!isRecord(value.sourceIdentity)) return null
  const source = value.sourceIdentity
  if (
    typeof source.kind !== 'string' ||
    typeof source.device !== 'string' ||
    typeof source.inode !== 'string' ||
    typeof source.size !== 'number' ||
    typeof source.mtime !== 'string'
  ) {
    return null
  }
  if (
    typeof value.expectedSize !== 'number' ||
    typeof value.durableOffset !== 'number' ||
    typeof value.chunkSize !== 'number' ||
    typeof value.createdAt !== 'number' ||
    typeof value.updatedAt !== 'number'
  ) {
    return null
  }
  if (value.expectedSha256 !== undefined && typeof value.expectedSha256 !== 'string') return null
  let lastChunk: TransferManifest['lastChunk'] = null
  if (value.lastChunk !== null) {
    if (
      !isRecord(value.lastChunk) ||
      typeof value.lastChunk.offset !== 'number' ||
      typeof value.lastChunk.size !== 'number' ||
      typeof value.lastChunk.sha256 !== 'string'
    ) {
      return null
    }
    lastChunk = {
      offset: value.lastChunk.offset,
      size: value.lastChunk.size,
      sha256: value.lastChunk.sha256
    }
  }
  return {
    protocolVersion: TRANSFER_MANIFEST_VERSION,
    transferId: value.transferId,
    direction: value.direction as TransferDirection,
    sourceIdentity: {
      kind: source.kind,
      device: source.device,
      inode: source.inode,
      size: source.size,
      mtime: source.mtime
    },
    expectedSize: value.expectedSize,
    ...(value.expectedSha256 === undefined ? {} : { expectedSha256: value.expectedSha256 }),
    durableOffset: value.durableOffset,
    chunkSize: value.chunkSize,
    lastChunk,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

export function sameSourceIdentity(
  left: TransferSourceIdentity,
  right: TransferSourceIdentity
): boolean {
  const crossSshHelper =
    new Set([left.kind, right.kind]).size === 2 &&
    [left.kind, right.kind].every((kind) => kind === 'file' || kind === 'ssh-file-v1')
  const leftTime = crossSshHelper ? Date.parse(left.mtime) : Number.NaN
  const rightTime = crossSshHelper ? Date.parse(right.mtime) : Number.NaN
  return (
    (left.kind === right.kind || crossSshHelper) &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    (left.mtime === right.mtime ||
      (crossSshHelper &&
        Number.isFinite(leftTime) &&
        Number.isFinite(rightTime) &&
        leftTime === rightTime))
  )
}
