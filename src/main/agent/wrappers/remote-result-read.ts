import { posix } from 'node:path'

import { hoverMediaPreviewType } from '../../file-preview-media'
import { readRemoteWorkspaceTextFile, REMOTE_READ_MAX_BYTES } from '../remote-workspace-read'
import { remoteWorkspaceUri } from '../../../shared/remoteWorkspacePath'
import type {
  WrapperResultRange,
  WrapperResultRangeRequest,
  WrapperResultReadRequest,
  WrapperResultPreview
} from '../../../shared/wrapperResultTypes'
import {
  MAX_REMOTE_LOG_RAW_BYTES,
  readRemoteFileChunk,
  type RemoteFileChunk
} from './remote-ssh-log'
import {
  withAuthorizedWrapperResultPath,
  type AuthorizedWrapperResultPath,
  type WrapperResultDependencies
} from './remote-results'
import type { RemoteSshSession } from './remote-ssh-session'

export const WRAPPER_RESULT_TEXT_MAX_BYTES = REMOTE_READ_MAX_BYTES
export const WRAPPER_RESULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024
export const WRAPPER_RESULT_RANGE_MAX_BYTES = MAX_REMOTE_LOG_RAW_BYTES
const SNIFF_BYTES = 16

function checkedReadRequest(input: unknown, range: false): WrapperResultReadRequest
function checkedReadRequest(input: unknown, range: true): WrapperResultRangeRequest
function checkedReadRequest(
  input: unknown,
  range: boolean
): WrapperResultReadRequest | WrapperResultRangeRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Wrapper 结果读取请求无效')
  }
  const record = input as Record<string, unknown>
  const keys = range
    ? ['projectId', 'hostProfileId', 'runId', 'scope', 'path', 'requestId', 'offset', 'length']
    : ['projectId', 'hostProfileId', 'runId', 'scope', 'path', 'requestId']
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    typeof record.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(record.requestId)
  ) {
    throw new Error('Wrapper 结果读取请求 ID 或参数无效')
  }
  if (
    range &&
    (!Number.isSafeInteger(record.offset) ||
      Number(record.offset) < 0 ||
      !Number.isSafeInteger(record.length) ||
      Number(record.length) < 1 ||
      Number(record.length) > WRAPPER_RESULT_RANGE_MAX_BYTES)
  ) {
    throw new Error('Wrapper 结果字节范围无效或超过单页上限')
  }
  return record as unknown as WrapperResultReadRequest | WrapperResultRangeRequest
}

function pathRequest(request: WrapperResultReadRequest): Record<string, unknown> {
  return {
    projectId: request.projectId,
    hostProfileId: request.hostProfileId,
    runId: request.runId,
    scope: request.scope,
    ...(request.path !== undefined ? { path: request.path } : {})
  }
}

export async function readAuthorizedResultChunk(
  session: RemoteSshSession,
  authorized: AuthorizedWrapperResultPath,
  offset: number,
  maxBytes: number,
  signal?: AbortSignal,
  identity?: string
): Promise<RemoteFileChunk> {
  let chunk: RemoteFileChunk
  try {
    chunk = await readRemoteFileChunk(session, authorized.path, {
      offset,
      maxBytes,
      canonicalRoot: authorized.root,
      noFollow: true,
      signal,
      identity
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('远程日志')) {
      throw new Error(error.message.replace(/^远程日志/, '远程结果'), { cause: error })
    }
    throw error
  }
  signal?.throwIfAborted()
  if (
    chunk.missing ||
    !chunk.identity ||
    chunk.reset ||
    chunk.startOffset !== offset ||
    chunk.bytes.length > maxBytes ||
    chunk.nextOffset !== offset + chunk.bytes.length
  ) {
    throw new Error('远程结果文件已消失、变化或返回了无效字节范围')
  }
  return chunk
}

function displayBase(
  authorized: AuthorizedWrapperResultPath,
  bytes: number
): {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  bytes: number
} {
  return {
    path: remoteWorkspaceUri(authorized.hostAlias, authorized.path),
    name: posix.basename(authorized.path),
    displayPath: `${authorized.hostAlias}${authorized.path}`,
    rootPath: remoteWorkspaceUri(authorized.hostAlias, authorized.root),
    rootLabel: authorized.hostAlias,
    bytes
  }
}

function unknownMime(path: string): string {
  return /\.(?:txt|md|log|json|csv|tsv|html?|xml|ya?ml|svg)$/i.test(path)
    ? 'text/plain'
    : 'application/octet-stream'
}

async function readMedia(
  session: RemoteSshSession,
  authorized: AuthorizedWrapperResultPath,
  first: RemoteFileChunk,
  signal?: AbortSignal
): Promise<Buffer> {
  const chunks = [first.bytes]
  let offset = first.nextOffset
  while (offset < first.size) {
    signal?.throwIfAborted()
    const next = await readAuthorizedResultChunk(
      session,
      authorized,
      offset,
      Math.min(WRAPPER_RESULT_RANGE_MAX_BYTES, first.size - offset),
      signal,
      first.identity
    )
    if (next.identity !== first.identity || next.size !== first.size || next.bytes.length === 0) {
      throw new Error('远程结果文件在预览期间发生变化')
    }
    chunks.push(next.bytes)
    offset = next.nextOffset
  }
  return Buffer.concat(chunks, first.size)
}

/** One range is at most 195 kB raw / 256 KiB SSH response, including zero-byte EOF reads. */
export async function readWrapperResultRange(
  input: unknown,
  dependencies: WrapperResultDependencies = {}
): Promise<WrapperResultRange> {
  const request = checkedReadRequest(input, true)
  return withAuthorizedWrapperResultPath(
    pathRequest(request),
    async (authorized, session) => {
      const chunk = await readAuthorizedResultChunk(
        session,
        authorized,
        request.offset,
        request.length,
        dependencies.signal
      )
      return {
        path: remoteWorkspaceUri(authorized.hostAlias, authorized.path),
        offset: chunk.startOffset,
        fileSize: chunk.size,
        bytes: chunk.bytes.length,
        identity: chunk.identity!,
        dataBase64: chunk.bytes.toString('base64')
      }
    },
    dependencies
  )
}

/** Preview only bounded text or supported media; large files return metadata without content. */
export async function previewWrapperResult(
  input: unknown,
  dependencies: WrapperResultDependencies = {}
): Promise<WrapperResultPreview> {
  const request = checkedReadRequest(input, false)
  return withAuthorizedWrapperResultPath(
    pathRequest(request),
    async (authorized, session) => {
      const first = await readAuthorizedResultChunk(
        session,
        authorized,
        0,
        SNIFF_BYTES,
        dependencies.signal
      )
      const base = displayBase(authorized, first.size)
      const media = hoverMediaPreviewType(first.bytes)
      if (media) {
        if (first.size > WRAPPER_RESULT_MEDIA_MAX_BYTES) {
          return {
            ...base,
            kind: 'metadata',
            mimeType: media.mimeType,
            reason: 'large_file',
            previewBytes: 0,
            truncated: true
          }
        }
        const bytes = await readMedia(session, authorized, first, dependencies.signal)
        const dataUrl = `data:${media.mimeType};base64,${bytes.toString('base64')}`
        return media.kind === 'pdf'
          ? {
              ...base,
              kind: 'pdf',
              mimeType: media.mimeType,
              dataUrl,
              previewBytes: bytes.length,
              truncated: false
            }
          : {
              ...base,
              kind: 'image',
              mimeType: media.mimeType,
              dataUrl,
              previewBytes: bytes.length,
              truncated: false
            }
      }
      if (first.size > WRAPPER_RESULT_TEXT_MAX_BYTES) {
        return {
          ...base,
          kind: 'metadata',
          mimeType: unknownMime(authorized.path),
          reason: 'large_file',
          previewBytes: 0,
          truncated: true
        }
      }
      try {
        const text = await readRemoteWorkspaceTextFile(
          session,
          authorized.path,
          authorized.root,
          dependencies.signal
        )
        if (
          text.fileSize !== first.size ||
          !Buffer.from(text.content, 'utf8').subarray(0, first.bytes.length).equals(first.bytes)
        ) {
          throw new Error('远程结果文件在预览期间发生变化')
        }
        return {
          ...base,
          kind: 'text',
          mimeType: 'text/plain',
          content: text.content,
          previewBytes: text.fileSize,
          truncated: false
        }
      } catch (error) {
        if (error instanceof Error && /二进制内容|不是有效的 UTF-8/.test(error.message)) {
          return {
            ...base,
            kind: 'metadata',
            mimeType: 'application/octet-stream',
            reason: 'binary',
            previewBytes: 0,
            truncated: false
          }
        }
        throw error
      }
    },
    dependencies
  )
}
