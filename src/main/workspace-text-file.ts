import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import {
  WORKSPACE_TEXT_MAX_BYTES,
  type WorkspaceTextSaveRequest,
  type WorkspaceTextSaveResult
} from '../shared/workspaceFileOperations'
import { remoteWorkspaceUri } from '../shared/remoteWorkspacePath'
import {
  resolveLocalWorkspaceFileTarget,
  validateWorkspaceFileOperation
} from './workspace-file-operations'
import {
  resolveRemoteWorkspaceHostBinding,
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies,
  type RemoteWorkspaceHostBinding
} from './agent/remote-workspace-boundary'
import { LocalHost } from './agent/workspace-host/local-host'
import { SshHost } from './agent/workspace-host/ssh-host'
import { createWorkspaceHostRemoteSession } from './agent/workspace-host/remote-session'
import type { WorkspaceHost } from './agent/workspace-host/types'

export interface WorkspaceTextFileDependencies extends RemoteWorkspaceBoundaryDependencies {
  beforeWrite?: () => void
  createRemoteHost?: (config: RemoteWorkspaceHostBinding['config']) => WorkspaceHost
}

function validateText(content: unknown): asserts content is string {
  if (typeof content !== 'string') throw new Error('文本内容必须是完整的 UTF-8 文本')
  const bytes = Buffer.from(content, 'utf8')
  if (
    bytes.length > WORKSPACE_TEXT_MAX_BYTES ||
    bytes.toString('utf8') !== content ||
    bytes.some((byte) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)
  ) {
    throw new Error(`只能保存完整的 UTF-8 文本，大小不超过 ${WORKSPACE_TEXT_MAX_BYTES} 字节`)
  }
}

export function validateWorkspaceTextSaveRequest(input: unknown): WorkspaceTextSaveRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('文本保存请求无效')
  }
  const { content, expectedContent, ...target } = input as Record<string, unknown>
  const request = validateWorkspaceFileOperation(target)
  validateText(content)
  validateText(expectedContent)
  return { ...request, content, expectedContent }
}

function conflict(): Error {
  return new Error('文本文件已在磁盘上变化，请重新加载后再保存')
}

function preserveTextFormat(content: string, original: string): string {
  let formatted = content
  if (original.includes('\r\n') && !/(?<!\r)\n/.test(original)) {
    formatted = formatted.replace(/\r?\n/g, '\r\n')
  }
  if (original.startsWith('\uFEFF') && !formatted.startsWith('\uFEFF')) {
    formatted = `\uFEFF${formatted}`
  }
  validateText(formatted)
  return formatted
}

async function saveOnHost(
  host: WorkspaceHost,
  path: string,
  request: WorkspaceTextSaveRequest,
  beforeWrite: () => Promise<void> | void
): Promise<Omit<WorkspaceTextSaveResult, 'path'>> {
  const stat = await host.fs.stat(path)
  if (stat.kind !== 'file') throw new Error('只能编辑普通文本文件')
  if (stat.size > WORKSPACE_TEXT_MAX_BYTES) {
    throw new Error(`文本文件超过 ${WORKSPACE_TEXT_MAX_BYTES} 字节，无法完整编辑`)
  }
  const source = await host.fs.readRange(path, {
    offset: 0,
    length: WORKSPACE_TEXT_MAX_BYTES + 1
  })
  if (!source.eof || source.bytesRead > WORKSPACE_TEXT_MAX_BYTES) {
    throw new Error('文本文件超过编辑大小上限')
  }
  let original: string
  try {
    original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.content)
  } catch {
    throw new Error('文本文件不是完整的 UTF-8 文本')
  }
  validateText(original)
  if (original !== request.expectedContent) throw conflict()
  const content = preserveTextFormat(request.content, original)
  await beforeWrite()
  try {
    await host.fs.writeAtomic(path, content, {
      expectedHash: createHash('sha256').update(source.content).digest('hex')
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'HASH_MISMATCH') {
      throw conflict()
    }
    throw error
  }
  return { content, bytes: Buffer.byteLength(content, 'utf8') }
}

/** Manual saves are restricted to existing UTF-8 text files in the current workspace. */
export async function saveWorkspaceTextFile(
  input: unknown,
  dependencies: WorkspaceTextFileDependencies = {}
): Promise<WorkspaceTextSaveResult> {
  const request = validateWorkspaceTextSaveRequest(input)
  if (request.kind === 'local') {
    const resolved = await resolveLocalWorkspaceFileTarget(request, dependencies.agentDir)
    const host = new LocalHost(request.rootPath)
    const saved = await saveOnHost(host, resolved.target, request, async () => {
      const latest = await resolveLocalWorkspaceFileTarget(request, dependencies.agentDir)
      if (latest.target !== resolved.target) throw new Error('文件路径已变化，请刷新后重试')
      dependencies.beforeWrite?.()
    })
    return { path: request.path, ...saved }
  }
  const binding = resolveRemoteWorkspaceHostBinding(
    { sessionId: request.sessionId, projectId: request.projectId },
    dependencies
  )
  const host = dependencies.createRemoteHost?.(binding.config) ?? new SshHost(binding.config)
  const assertBinding = (): void => {
    if (
      resolveRemoteWorkspaceHostBinding(
        { sessionId: request.sessionId, projectId: request.projectId },
        dependencies
      ).cacheKey !== binding.cacheKey
    ) {
      throw new Error('远程项目连接已变化，请刷新后重试')
    }
  }
  try {
    return await withAuthorizedRemoteWorkspacePath(
      {
        sessionId: request.sessionId,
        projectId: request.projectId,
        path: request.path,
        mode: 'existing'
      },
      async (authorized) => {
        const expected =
          request.path === binding.remoteRoot || request.path.startsWith(`${binding.remoteRoot}/`)
            ? posix.join(binding.canonicalRoot, posix.relative(binding.remoteRoot, request.path))
            : posix.normalize(request.path)
        if (authorized.path === binding.canonicalRoot || expected !== authorized.path) {
          throw new Error('不能编辑工作区根目录、符号链接或经过符号链接的路径')
        }
        assertBinding()
        const saved = await saveOnHost(host, authorized.path, request, () => {
          assertBinding()
          dependencies.beforeWrite?.()
        })
        return { path: remoteWorkspaceUri(binding.hostAlias, authorized.path), ...saved }
      },
      {
        ...dependencies,
        connectHost: async () => createWorkspaceHostRemoteSession(host, binding.canonicalRoot)
      }
    )
  } finally {
    await host.close?.()
  }
}
