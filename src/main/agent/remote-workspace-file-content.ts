import { posix } from 'node:path'

import { mediaPreviewType, type PreviewImageMimeType } from '../file-preview-media'
import { MAX_REMOTE_LOG_RAW_BYTES, readRemoteFileChunk } from './wrappers/remote-ssh-log'
import { shellQuote, type RemoteSshSession } from './wrappers/remote-ssh-session'

export const REMOTE_FILE_SNIFF_BYTES = 512
export const REMOTE_FILE_PREVIEW_BYTES = 320_000
export const REMOTE_FILE_MEDIA_BYTES = 10 * 1024 * 1024

export interface RemoteFileSnapshot {
  size: number
  head: Buffer
  identity: string
}

export type RemoteFileClassification =
  | { kind: 'text'; mimeType: 'text/plain' }
  | { kind: 'image'; mimeType: PreviewImageMimeType; label: string }
  | { kind: 'pdf'; mimeType: 'application/pdf'; label: 'PDF' }
  | { kind: 'binary'; mimeType: string; label: string }

type BinaryExtension = { suffixes: readonly string[]; label: string; mimeType: string }

const BINARY_EXTENSIONS: readonly BinaryExtension[] = [
  { suffixes: ['.bam'], label: 'BAM', mimeType: 'application/x-bam' },
  { suffixes: ['.cram'], label: 'CRAM', mimeType: 'application/x-cram' },
  { suffixes: ['.bai'], label: 'BAI', mimeType: 'application/x-bai' },
  { suffixes: ['.tbi'], label: 'TBI', mimeType: 'application/x-tabix-index' },
  { suffixes: ['.csi'], label: 'CSI', mimeType: 'application/x-csi' },
  { suffixes: ['.2bit'], label: '2BIT', mimeType: 'application/x-2bit' },
  { suffixes: ['.sra'], label: 'SRA', mimeType: 'application/x-sra' },
  { suffixes: ['.crai'], label: 'CRAI', mimeType: 'application/x-crai' },
  { suffixes: ['.bcf'], label: 'BCF', mimeType: 'application/x-bcf' },
  { suffixes: ['.bw', '.bigwig'], label: 'BIGWIG', mimeType: 'application/x-bigwig' },
  { suffixes: ['.bb', '.bigbed'], label: 'BIGBED', mimeType: 'application/x-bigbed' },
  {
    suffixes: ['.h5', '.hdf5', '.h5ad', '.loom', '.cool', '.mcool'],
    label: 'HDF5',
    mimeType: 'application/x-hdf5'
  },
  { suffixes: ['.parquet'], label: 'PARQUET', mimeType: 'application/vnd.apache.parquet' },
  {
    suffixes: ['.sqlite', '.sqlite3', '.db'],
    label: 'SQLITE',
    mimeType: 'application/vnd.sqlite3'
  },
  { suffixes: ['.gz', '.bgz', '.bgzf', '.tgz'], label: 'GZIP', mimeType: 'application/gzip' },
  { suffixes: ['.bz2', '.tbz2'], label: 'BZIP2', mimeType: 'application/x-bzip2' },
  { suffixes: ['.zst', '.zstd'], label: 'ZSTD', mimeType: 'application/zstd' },
  { suffixes: ['.xz', '.txz'], label: 'XZ', mimeType: 'application/x-xz' },
  {
    suffixes: ['.zip', '.jar', '.npz', '.docx', '.xlsx', '.pptx'],
    label: 'ZIP',
    mimeType: 'application/zip'
  },
  { suffixes: ['.7z'], label: '7Z', mimeType: 'application/x-7z-compressed' },
  { suffixes: ['.rar'], label: 'RAR', mimeType: 'application/vnd.rar' },
  { suffixes: ['.tar'], label: 'TAR', mimeType: 'application/x-tar' },
  {
    suffixes: ['.arrow', '.feather'],
    label: 'ARROW',
    mimeType: 'application/vnd.apache.arrow.file'
  },
  { suffixes: ['.avro'], label: 'AVRO', mimeType: 'application/avro' },
  { suffixes: ['.npy'], label: 'NUMPY', mimeType: 'application/x-npy' },
  {
    suffixes: ['.pkl', '.pickle', '.joblib'],
    label: 'PICKLE',
    mimeType: 'application/python-pickle'
  },
  { suffixes: ['.rds', '.rdata', '.rda'], label: 'R DATA', mimeType: 'application/x-r-data' },
  { suffixes: ['.mat'], label: 'MATLAB', mimeType: 'application/x-matlab-data' },
  { suffixes: ['.dcm', '.dicom'], label: 'DICOM', mimeType: 'application/dicom' },
  { suffixes: ['.doc', '.xls', '.ppt'], label: 'OFFICE', mimeType: 'application/octet-stream' },
  {
    suffixes: ['.class', '.pyc', '.wasm', '.o', '.a', '.so', '.dylib', '.dll', '.exe'],
    label: 'BINARY',
    mimeType: 'application/octet-stream'
  }
]

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function magicBinary(
  bytes: Buffer
): Omit<Extract<RemoteFileClassification, { kind: 'binary' }>, 'kind'> | null {
  if (startsWith(bytes, [0x42, 0x41, 0x4d, 0x01])) {
    return { label: 'BAM', mimeType: 'application/x-bam' }
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'CRAM') {
    return { label: 'CRAM', mimeType: 'application/x-cram' }
  }
  if (startsWith(bytes, [0x42, 0x41, 0x49, 0x01])) {
    return { label: 'BAI', mimeType: 'application/x-bai' }
  }
  if (startsWith(bytes, [0x54, 0x42, 0x49, 0x01])) {
    return { label: 'TBI', mimeType: 'application/x-tabix-index' }
  }
  if (startsWith(bytes, [0x43, 0x53, 0x49, 0x01])) {
    return { label: 'CSI', mimeType: 'application/x-csi' }
  }
  if (startsWith(bytes, [0x42, 0x43, 0x46])) {
    return { label: 'BCF', mimeType: 'application/x-bcf' }
  }
  if (startsWith(bytes, [0x26, 0xfc, 0x8f, 0x88]) || startsWith(bytes, [0x88, 0x8f, 0xfc, 0x26])) {
    return { label: 'BIGWIG', mimeType: 'application/x-bigwig' }
  }
  if (startsWith(bytes, [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { label: 'HDF5', mimeType: 'application/x-hdf5' }
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'PAR1') {
    return { label: 'PARQUET', mimeType: 'application/vnd.apache.parquet' }
  }
  if (bytes.subarray(0, 16).toString('ascii') === 'SQLite format 3\0') {
    return { label: 'SQLITE', mimeType: 'application/vnd.sqlite3' }
  }
  if (startsWith(bytes, [0x1f, 0x8b])) return { label: 'GZIP', mimeType: 'application/gzip' }
  if (bytes.subarray(0, 3).toString('ascii') === 'BZh') {
    return { label: 'BZIP2', mimeType: 'application/x-bzip2' }
  }
  if (startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd])) {
    return { label: 'ZSTD', mimeType: 'application/zstd' }
  }
  if (startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) {
    return { label: 'XZ', mimeType: 'application/x-xz' }
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return { label: 'ZIP', mimeType: 'application/zip' }
  }
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return { label: '7Z', mimeType: 'application/x-7z-compressed' }
  }
  if (bytes.length >= 132 && bytes.subarray(128, 132).toString('ascii') === 'DICM') {
    return { label: 'DICOM', mimeType: 'application/dicom' }
  }
  if (startsWith(bytes, [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59])) {
    return { label: 'NUMPY', mimeType: 'application/x-npy' }
  }
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(bytes, [0x00, 0x61, 0x73, 0x6d])) {
    return { label: 'BINARY', mimeType: 'application/octet-stream' }
  }
  return null
}

function probablyBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return false
  } catch {
    return true
  }
}

export function classifyRemoteWorkspaceFile(path: string, head: Buffer): RemoteFileClassification {
  const media = mediaPreviewType(head)
  if (media?.kind === 'image') {
    return {
      kind: 'image',
      mimeType: media.mimeType,
      label: media.mimeType.slice(6).toUpperCase()
    }
  }
  if (media?.kind === 'pdf') {
    return { kind: 'pdf', mimeType: 'application/pdf', label: 'PDF' }
  }

  const lower = posix.basename(path).toLowerCase()
  const extension = BINARY_EXTENSIONS.find((entry) =>
    entry.suffixes.some((suffix) => lower.endsWith(suffix))
  )
  if (extension) {
    return { kind: 'binary', label: extension.label, mimeType: extension.mimeType }
  }
  const magic = magicBinary(head)
  if (magic) return { kind: 'binary', ...magic }
  if (probablyBinary(head)) {
    return { kind: 'binary', label: 'BINARY', mimeType: 'application/octet-stream' }
  }
  return { kind: 'text', mimeType: 'text/plain' }
}

export function binaryReadExplanation(path: string, label: string): string {
  const quoted = shellQuote(path)
  const command =
    label === 'BAM'
      ? `samtools view -H ${quoted}`
      : label === 'GZIP'
        ? `zcat ${quoted} | head`
        : `file ${quoted}`
  return `二进制文件（${label}），不支持文本预览。可在 bash 中使用 \`${command}\` 检查。`
}

export async function inspectRemoteWorkspaceFile(
  session: RemoteSshSession,
  path: string,
  canonicalRoot: string,
  signal?: AbortSignal,
  relativePath?: string
): Promise<RemoteFileSnapshot> {
  signal?.throwIfAborted()
  const first = await readRemoteFileChunk(session, path, {
    offset: 0,
    maxBytes: REMOTE_FILE_SNIFF_BYTES,
    canonicalRoot,
    noFollow: true,
    signal
  })
  if (first.missing) {
    const suffix = relativePath ? `：${relativePath}` : ''
    throw new Error(`远程目标不存在${suffix}`)
  }
  if (first.startOffset !== 0 || first.bytes.length > REMOTE_FILE_SNIFF_BYTES || !first.identity) {
    throw new Error('远程文件字节范围返回无效')
  }
  return { size: first.size, head: first.bytes, identity: first.identity }
}

export async function readRemoteWorkspaceFileRange(
  session: RemoteSshSession,
  path: string,
  canonicalRoot: string,
  snapshot: RemoteFileSnapshot,
  offset: number,
  length: number,
  signal?: AbortSignal
): Promise<Buffer> {
  signal?.throwIfAborted()
  if (length < 1) return Buffer.alloc(0)
  const chunk = await readRemoteFileChunk(session, path, {
    offset,
    maxBytes: length,
    identity: snapshot.identity,
    canonicalRoot,
    noFollow: true,
    signal
  })
  if (
    chunk.missing ||
    chunk.reset ||
    chunk.identity !== snapshot.identity ||
    chunk.size !== snapshot.size ||
    chunk.startOffset !== offset
  ) {
    throw new Error('远程文件在读取期间发生变化')
  }
  return chunk.bytes
}

/** Encodes bounded media one range at a time; only the final base64 string grows with the file. */
export async function readRemoteWorkspaceFileBase64(
  session: RemoteSshSession,
  path: string,
  canonicalRoot: string,
  snapshot: RemoteFileSnapshot,
  limit: number,
  signal?: AbortSignal
): Promise<string> {
  const target = Math.min(snapshot.size, limit)
  let offset = 0
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let encoded = ''
  while (offset < target) {
    const length = Math.min(MAX_REMOTE_LOG_RAW_BYTES, target - offset)
    const bytes = await readRemoteWorkspaceFileRange(
      session,
      path,
      canonicalRoot,
      snapshot,
      offset,
      length,
      signal
    )
    if (bytes.length === 0) throw new Error('远程文件在读取期间发生变化')
    offset += bytes.length
    const joined = carry.length === 0 ? bytes : Buffer.concat([carry, bytes])
    const completeLength = offset >= target ? joined.length : joined.length - (joined.length % 3)
    if (completeLength > 0) encoded += joined.subarray(0, completeLength).toString('base64')
    carry = joined.subarray(completeLength)
  }
  if (carry.length > 0) encoded += carry.toString('base64')
  return encoded
}

export async function readRemoteWorkspaceFilePrefix(
  session: RemoteSshSession,
  path: string,
  canonicalRoot: string,
  snapshot: RemoteFileSnapshot,
  limit: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const target = Math.min(snapshot.size, limit)
  if (target <= snapshot.head.length) return snapshot.head.subarray(0, target)
  const output = Buffer.allocUnsafe(target)
  snapshot.head.copy(output)
  let offset = snapshot.head.length
  while (offset < target) {
    const length = Math.min(MAX_REMOTE_LOG_RAW_BYTES, target - offset)
    const bytes = await readRemoteWorkspaceFileRange(
      session,
      path,
      canonicalRoot,
      snapshot,
      offset,
      length,
      signal
    )
    if (bytes.length === 0) throw new Error('远程文件在读取期间发生变化')
    bytes.copy(output, offset)
    offset += bytes.length
  }
  return output
}
