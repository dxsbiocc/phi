import { posix } from 'node:path'

import type { RemoteWorkspaceFileRequest } from '../../shared/remoteWorkspacePath'
import { remoteWorkspaceUri } from '../../shared/remoteWorkspacePath'
import { readRemoteWorkspacePath, type RemoteWorkspaceReadResult } from './remote-workspace-read'
import type {
  AuthorizedRemoteWorkspacePath,
  RemoteWorkspaceBoundaryDependencies
} from './remote-workspace-boundary'

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

async function readForUi(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies,
  expectedKind: 'file' | 'directory'
): Promise<{ authorized: AuthorizedRemoteWorkspacePath; result: RemoteWorkspaceReadResult }> {
  const request = checkedRequest(input)
  let authorized: AuthorizedRemoteWorkspacePath | undefined
  const result = await readRemoteWorkspacePath(request, {
    ...dependencies,
    expectedKind,
    onResolved: (value) => {
      authorized = value
    }
  })
  if (!authorized) throw new Error('远程文件授权结果不可用')
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
  const { authorized, result } = await readForUi(input, dependencies, 'directory')
  if (result.kind !== 'directory') throw new Error('远程目标不是目录')
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

/** Existing text preview DTO. T02 already refuses binary, special and >1 MiB files. */
export async function previewRemoteWorkspaceFile(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies = {}
): Promise<{
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  kind: 'text'
  mimeType: 'text/plain'
  bytes: number
  previewBytes: number
  truncated: false
  content: string
}> {
  const { authorized, result } = await readForUi(input, dependencies, 'file')
  if (result.kind !== 'file') throw new Error('远程目标不是普通文本文件')
  return {
    path: result.path,
    name: posix.basename(authorized.path),
    displayPath: `${authorized.hostAlias}${authorized.path}`,
    rootPath: remoteWorkspaceUri(authorized.hostAlias, authorized.canonicalRoot),
    rootLabel: authorized.hostAlias,
    kind: 'text',
    mimeType: 'text/plain',
    bytes: result.fileSize,
    previewBytes: result.fileSize,
    truncated: false,
    content: result.content
  }
}
