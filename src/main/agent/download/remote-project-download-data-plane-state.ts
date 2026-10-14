import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import type { PartialInspection } from '../transfer/data-plane'
import { TransferError } from '../transfer/errors'
import { parseTransferManifest, type TransferManifest } from '../transfer/manifest'
import type { RemoteHashTool } from '../transfer/ssh-data-plane-scripts'
import type { TransferSourceIdentity } from '../transfer/types'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'

const SHA256 = /^[a-f0-9]{64}$/u

/** Desktop-only authority; never serialized in a request, manifest, or receipt. */
export type RemoteProjectDownloadControl = Readonly<{
  signal?: AbortSignal
  beforeDispatch?: () => void
}>

export function assertRemoteDownloadCurrent(control?: RemoteProjectDownloadControl): void {
  control?.signal?.throwIfAborted()
  control?.beforeDispatch?.()
  control?.signal?.throwIfAborted()
}

export type RemoteProjectDownloadContext = Readonly<{
  transferId: string
  hostKey: string
  workspaceId: string
  session: RemoteSshSession
  url: string
  sourceFingerprint: string
  curlResolve?: string
  destination: string
  relativePath: string
  canonicalRoot: string
  maxFileBytes: number
  control?: RemoteProjectDownloadControl
}>

export type PreflightState = Readonly<{
  hashTool: RemoteHashTool
  availableBytes: number
  partial: PartialInspection
  manifest: TransferManifest | null
}>

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

type RemoteDownloadLocator = Readonly<{
  version: 1
  hostKey: string
  canonicalRoot: string
  path: string
}>

export function locator(context: RemoteProjectDownloadContext, path: string): string {
  const value: RemoteDownloadLocator = {
    version: 1,
    hostKey: context.hostKey,
    canonicalRoot: context.canonicalRoot,
    path
  }
  return `remote-http:${Buffer.from(JSON.stringify(value)).toString('base64url')}`
}

export function parseLocator(value: string, hostKey: string): RemoteDownloadLocator {
  const encoded = value.startsWith('remote-http:') ? value.slice('remote-http:'.length) : ''
  if (!encoded || encoded.length > 16 * 1024) {
    throw new TransferError('INVALID_PARTIAL', 'Remote download registry locator is invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new TransferError('INVALID_PARTIAL', 'Remote download registry locator is invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TransferError('INVALID_PARTIAL', 'Remote download registry locator is invalid')
  }
  const item = parsed as Record<string, unknown>
  if (
    Object.keys(item).some(
      (key) => !['version', 'hostKey', 'canonicalRoot', 'path'].includes(key)
    ) ||
    item.version !== 1 ||
    item.hostKey !== hostKey ||
    typeof item.canonicalRoot !== 'string' ||
    typeof item.path !== 'string' ||
    !posix.isAbsolute(item.canonicalRoot) ||
    posix.normalize(item.canonicalRoot) !== item.canonicalRoot ||
    !posix.isAbsolute(item.path) ||
    posix.normalize(item.path) !== item.path ||
    /[\0\r\n]/u.test(item.canonicalRoot + item.path) ||
    (item.path !== item.canonicalRoot && !item.path.startsWith(`${item.canonicalRoot}/`))
  ) {
    throw new TransferError('INVALID_PARTIAL', 'Remote download registry locator is invalid')
  }
  return item as unknown as RemoteDownloadLocator
}

export function lineValue(output: string, key: string): string | null {
  const prefix = `${key}=`
  return (
    output
      .split(/\r?\n/u)
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length) ?? null
  )
}

export function decodeManifest(hex: string): TransferManifest | null {
  if (!hex) return null
  if (!/^(?:[a-f0-9]{2})+$/iu.test(hex) || hex.length > 128 * 1024) {
    throw new TransferError('INVALID_MANIFEST', 'Remote transfer manifest encoding is invalid')
  }
  try {
    const parsed = parseTransferManifest(JSON.parse(Buffer.from(hex, 'hex').toString('utf8')))
    if (parsed) return parsed
  } catch {
    // The generic error below is intentionally bounded and contains no manifest contents.
  }
  throw new TransferError('INVALID_MANIFEST', 'Remote transfer manifest is invalid')
}

export function mappedControlError(output: string, fallback: string): TransferError {
  switch (lineValue(output, 'PHI_ERROR')) {
    case 'DESTINATION_EXISTS':
      return new TransferError(
        'DESTINATION_EXISTS',
        '远程下载目标已存在或在发布时被占用；未覆盖现有文件。'
      )
    case 'HASH_UNAVAILABLE':
      return new TransferError(
        'HASH_UNAVAILABLE',
        '服务器缺少 SHA-256 工具，无法执行已校验的下载。'
      )
    case 'HASH_MISMATCH':
      return new TransferError('HASH_MISMATCH', '服务器下载文件的 SHA-256 校验失败。')
    case 'INVALID_MANIFEST':
      return new TransferError('INVALID_MANIFEST', '远程下载续传 metadata 无效。')
    case 'INVALID_PARTIAL':
    case 'OFFSET_MISMATCH':
      return new TransferError('INVALID_PARTIAL', '远程下载 partial 无效。')
    case 'INVALID_PATH':
      return new TransferError('INVALID_REQUEST', '远程下载目标父目录已变化或移出项目根目录。')
    case 'WRITE_UNAVAILABLE':
    case 'SPACE_UNAVAILABLE':
      return new TransferError('INSUFFICIENT_SPACE', '远程下载目标空间不足或不可写。')
    default:
      return new TransferError('TRANSFER_FAILED', fallback)
  }
}

export function checkedNumber(value: string | null, label: string): number {
  const parsed = value === null ? Number.NaN : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TransferError('TRANSFER_FAILED', `${label} response is invalid`)
  }
  return parsed
}

export function preflightState(output: string): PreflightState {
  const hashTool = lineValue(output, 'PHI_HASH')
  if (!['sha256sum', 'shasum', 'openssl', 'perl'].includes(hashTool ?? '')) {
    throw new TransferError('HASH_UNAVAILABLE', '服务器缺少 SHA-256 工具，无法执行已校验的下载。')
  }
  const availableBytes = checkedNumber(lineValue(output, 'PHI_SPACE'), 'Remote space')
  const encodedPart = lineValue(output, 'PHI_PART')?.split(':')
  if (!encodedPart || !['missing', 'file'].includes(encodedPart[0] ?? '')) {
    throw new TransferError('INVALID_PARTIAL', '远程下载 partial 状态无效。')
  }
  const size = checkedNumber(encodedPart[1] ?? null, 'Remote partial')
  return {
    hashTool: hashTool as RemoteHashTool,
    availableBytes,
    partial:
      encodedPart[0] === 'file'
        ? {
            kind: 'file',
            size,
            ownerId: typeof process.getuid === 'function' ? process.getuid() : null
          }
        : { kind: 'missing', size: 0, ownerId: null },
    manifest: decodeManifest(lineValue(output, 'PHI_MANIFEST_HEX') ?? '')
  }
}

export type HttpIdentity = Readonly<{
  identity: TransferSourceIdentity
  ifRange?: string
  remoteSha256?: string
}>

function decodedHeader(output: string, key: string): string {
  const encoded = lineValue(output, key)
  if (encoded === null || encoded === '') return ''
  if (!/^(?:[a-f0-9]{2})+$/iu.test(encoded) || encoded.length > 4096) {
    throw new TransferError('TRANSFER_FAILED', 'Remote HTTP identity is invalid')
  }
  const value = Buffer.from(encoded, 'hex').toString('utf8').trim()
  if (/[\0\r\n]/u.test(value) || Buffer.byteLength(value) > 1024) {
    throw new TransferError('TRANSFER_FAILED', 'Remote HTTP identity is invalid')
  }
  return value
}

function advertisedSha256(output: string): string | undefined {
  const checksum = decodedHeader(output, 'PHI_HTTP_SHA256_HEX').toLowerCase()
  if (checksum) {
    if (!SHA256.test(checksum)) {
      throw new TransferError('TRANSFER_FAILED', 'Remote HTTP SHA-256 header is invalid')
    }
    return checksum
  }
  const digest = decodedHeader(output, 'PHI_HTTP_DIGEST_HEX')
  const match = /^sha-256=:([A-Za-z0-9+/]+={0,2}):$/iu.exec(digest)
  if (!match) return undefined
  const decoded = Buffer.from(match[1], 'base64')
  return decoded.byteLength === 32 ? decoded.toString('hex') : undefined
}

export function sourceIdentity(
  output: string,
  context: RemoteProjectDownloadContext
): HttpIdentity {
  const code = checkedNumber(lineValue(output, 'PHI_HTTP_CODE'), 'HTTP status')
  if (code >= 300 && code < 400) {
    throw new TransferError(
      'TRANSFER_FAILED',
      '服务器下载地址发生重定向；请提供最终的公开 HTTPS 地址后重试。'
    )
  }
  if (code < 200 || code >= 300) {
    throw new TransferError(
      'TRANSFER_FAILED',
      '服务器无法联网或无法访问该地址；请检查服务器网络/防火墙后重试。'
    )
  }
  const size = checkedNumber(lineValue(output, 'PHI_HTTP_SIZE'), 'HTTP Content-Length')
  if (size > context.maxFileBytes) {
    throw new TransferError('TRANSFER_FAILED', '服务器下载文件超过 maxFileBytes。')
  }
  const etag = decodedHeader(output, 'PHI_HTTP_ETAG_HEX')
  const lastModified = decodedHeader(output, 'PHI_HTTP_LAST_MODIFIED_HEX')
  const strongEtag = etag && !/^W\//iu.test(etag) ? etag : undefined
  const ifRange = strongEtag ?? (lastModified || undefined)
  return {
    identity: {
      kind: 'remote-http',
      device: sha256(strongEtag ?? 'missing-strong-etag'),
      inode: sha256(lastModified || 'missing-last-modified'),
      size,
      mtime: context.sourceFingerprint
    },
    ...(ifRange ? { ifRange } : {}),
    ...(advertisedSha256(output) ? { remoteSha256: advertisedSha256(output) } : {})
  }
}
