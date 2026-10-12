import { posix } from 'node:path'

import type { RemoteWorkspaceFileRequest } from '../../shared/remoteWorkspacePath'
import { remoteWorkspaceUri } from '../../shared/remoteWorkspacePath'
import type { PreviewImageMimeType } from '../file-preview-media'
import {
  RemoteWorkspaceTargetMissingError,
  withAuthorizedRemoteWorkspacePath,
  type AuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from './remote-workspace-boundary'
import {
  classifyRemoteWorkspaceFile,
  inspectRemoteWorkspaceFile,
  readRemoteWorkspaceFileBase64,
  readRemoteWorkspaceFilePrefix,
  REMOTE_FILE_MEDIA_BYTES,
  REMOTE_FILE_PREVIEW_BYTES
} from './remote-workspace-file-content'
import { readRemoteWorkspacePath, type RemoteWorkspaceReadResult } from './remote-workspace-read'

function checkedRequest(value: unknown): RemoteWorkspaceFileRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('远程文件请求无效')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some((key) => !['sessionId', 'projectId', 'path'].includes(key)) ||
    typeof record.sessionId !== 'string' ||
    !record.sessionId ||
    typeof record.projectId !== 'string' ||
    !record.projectId ||
    typeof record.path !== 'string' ||
    !record.path
  ) {
    throw new Error('远程文件请求只能包含会话、项目 ID 和路径')
  }
  return record as unknown as RemoteWorkspaceFileRequest
}

async function readDirectoryForUi(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies
): Promise<{
  authorized: AuthorizedRemoteWorkspacePath
  result: Extract<RemoteWorkspaceReadResult, { kind: 'directory' }>
}> {
  const request = checkedRequest(input)
  let authorized: AuthorizedRemoteWorkspacePath | undefined
  let result: RemoteWorkspaceReadResult
  try {
    result = await readRemoteWorkspacePath(request, {
      ...dependencies,
      expectedKind: 'directory',
      onResolved: (value) => {
        authorized = value
      }
    })
  } catch (error) {
    if (!(error instanceof RemoteWorkspaceTargetMissingError)) throw error
    const relativePath = error.relativePath ?? request.path
    throw new Error(`远程目录不存在：${relativePath}`)
  }
  if (!authorized) throw new Error('远程文件授权结果不可用')
  if (result.kind !== 'directory') throw new Error('远程目标不是目录')
  return { authorized, result }
}

/** Existing project tree DTO, backed only by T02's authorized SSH directory read. */
export async function listRemoteWorkspaceDirectory(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies = {}
): Promise<{
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  entries: Array<{ path: string; name: string; displayPath: string; kind: 'directory' | 'file' }>
  truncated: boolean
}> {
  const { authorized, result } = await readDirectoryForUi(input, dependencies)
  return {
    path: result.path,
    name: posix.basename(authorized.path) || '/',
    displayPath: `${authorized.hostAlias}${authorized.path}`,
    rootPath: remoteWorkspaceUri(authorized.hostAlias, authorized.canonicalRoot),
    rootLabel: authorized.hostAlias,
    entries: result.entries.map((entry) => {
      const childPath = posix.join(authorized.path, entry.name)
      return {
        path: remoteWorkspaceUri(authorized.hostAlias, childPath),
        name: entry.name,
        displayPath: `${authorized.hostAlias}${childPath}`,
        kind: entry.isDirectory ? 'directory' : 'file'
      }
    }),
    truncated: false
  }
}

type RemoteFilePreviewBase = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  bytes: number
  previewBytes: number
  truncated: boolean
}

type RemoteFilePreview = RemoteFilePreviewBase &
  (
    | { kind: 'text'; mimeType: 'text/plain'; content: string }
    | { kind: 'html'; mimeType: 'text/html'; content: string }
    | { kind: 'image'; mimeType: PreviewImageMimeType; dataUrl: string }
    | { kind: 'pdf'; mimeType: 'application/pdf'; dataUrl: string }
    | { kind: 'metadata'; mimeType: string; reason: 'large_file' | 'binary' }
  )

function previewBase(
  authorized: AuthorizedRemoteWorkspacePath,
  bytes: number,
  previewBytes: number,
  truncated: boolean
): RemoteFilePreviewBase {
  return {
    path: remoteWorkspaceUri(authorized.hostAlias, authorized.path),
    name: posix.basename(authorized.path),
    displayPath: `${authorized.hostAlias}${authorized.path}`,
    rootPath: remoteWorkspaceUri(authorized.hostAlias, authorized.canonicalRoot),
    rootLabel: authorized.hostAlias,
    bytes,
    previewBytes,
    truncated
  }
}

/** Local-parity preview: classify from a 512-byte head, then read only the required ranges. */
export async function previewRemoteWorkspaceFile(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies = {}
): Promise<RemoteFilePreview> {
  const request = checkedRequest(input)
  try {
    return await withAuthorizedRemoteWorkspacePath(
      { ...request, mode: 'existing' },
      async (authorized, session) => {
        const snapshot = await inspectRemoteWorkspaceFile(
          session,
          authorized.path,
          authorized.canonicalRoot,
          undefined,
          authorized.relativePath || request.path
        )
        const classification = classifyRemoteWorkspaceFile(authorized.path, snapshot.head)
        const headBase = previewBase(
          authorized,
          snapshot.size,
          snapshot.head.length,
          snapshot.size > snapshot.head.length
        )

        if (classification.kind === 'image' || classification.kind === 'pdf') {
          if (snapshot.size > REMOTE_FILE_MEDIA_BYTES) {
            return {
              ...headBase,
              kind: 'metadata',
              mimeType: classification.mimeType,
              reason: 'large_file'
            }
          }
          const data = await readRemoteWorkspaceFileBase64(
            session,
            authorized.path,
            authorized.canonicalRoot,
            snapshot,
            snapshot.size
          )
          const dataUrl = `data:${classification.mimeType};base64,${data}`
          const base = previewBase(authorized, snapshot.size, snapshot.size, false)
          return classification.kind === 'image'
            ? { ...base, kind: 'image', mimeType: classification.mimeType, dataUrl }
            : { ...base, kind: 'pdf', mimeType: 'application/pdf', dataUrl }
        }

        if (classification.kind === 'binary') {
          return {
            ...headBase,
            kind: 'metadata',
            mimeType: classification.mimeType,
            reason: 'binary'
          }
        }

        const previewBytes = await readRemoteWorkspaceFilePrefix(
          session,
          authorized.path,
          authorized.canonicalRoot,
          snapshot,
          REMOTE_FILE_PREVIEW_BYTES
        )
        const previewClassification = classifyRemoteWorkspaceFile(authorized.path, previewBytes)
        const preview = previewBase(
          authorized,
          snapshot.size,
          previewBytes.length,
          snapshot.size > previewBytes.length
        )
        if (previewClassification.kind === 'binary') {
          return {
            ...preview,
            kind: 'metadata',
            mimeType: previewClassification.mimeType,
            reason: 'binary'
          }
        }

        const html = /\.html?$/i.test(authorized.path)
        if (html && snapshot.size <= REMOTE_FILE_MEDIA_BYTES) {
          const htmlBytes =
            previewBytes.length === snapshot.size
              ? previewBytes
              : await readRemoteWorkspaceFilePrefix(
                  session,
                  authorized.path,
                  authorized.canonicalRoot,
                  snapshot,
                  snapshot.size
                )
          return {
            ...previewBase(authorized, snapshot.size, htmlBytes.length, false),
            kind: 'html',
            mimeType: 'text/html',
            content: htmlBytes.toString('utf8')
          }
        }
        return {
          ...preview,
          kind: 'text',
          mimeType: 'text/plain',
          content: previewBytes.toString('utf8')
        }
      },
      { ...dependencies, execTimeoutMs: dependencies.execTimeoutMs ?? 30_000 }
    )
  } catch (error) {
    if (!(error instanceof RemoteWorkspaceTargetMissingError)) {
      if (!(error instanceof Error) || !error.message.startsWith('远程目标不存在')) throw error
    }
    throw new Error(`远程文件不存在：${request.path}`)
  }
}
