import { isAbsolute, resolve } from 'node:path'

import type { RemoteWorkspaceFileDownloadRequest } from '../../shared/workspaceFileOperations'
import type {
  WrapperResultDownloadProgress,
  WrapperResultDownloadResult
} from '../../shared/wrapperResultTypes'
import {
  resolveRemoteWorkspaceHostBinding,
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from './remote-workspace-boundary'
import type { FileTransferCoordinator } from './transfer'
import { getProject } from './projects'
import {
  captureWrapperDownloadTarget,
  transferAuthorizedWrapperResult
} from './wrappers/remote-result-transfer'
import type { RemoteSshSession } from './wrappers/remote-ssh-session'

const activeDestinations = new Set<string>()

export function validateRemoteWorkspaceDownloadRequest(
  input: unknown
): RemoteWorkspaceFileDownloadRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('远程文件下载请求无效')
  }
  const value = input as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) => !['sessionId', 'projectId', 'path', 'requestId'].includes(key)
    ) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    typeof value.path !== 'string' ||
    !value.path.startsWith('/') ||
    value.path.includes('\0') ||
    value.path.split('/').includes('..') ||
    typeof value.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId)
  ) {
    throw new Error('远程下载只能指定当前会话、项目和绝对文件路径')
  }
  return value as unknown as RemoteWorkspaceFileDownloadRequest
}

/** Destination is selected by Electron's save dialog, never accepted over IPC. */
export async function downloadRemoteWorkspaceFileToPath(
  input: unknown,
  destinationInput: string,
  dependencies: RemoteWorkspaceBoundaryDependencies & {
    signal?: AbortSignal
    transferCoordinator?: FileTransferCoordinator
    onProgress?: (progress: WrapperResultDownloadProgress) => void
  } = {}
): Promise<Extract<WrapperResultDownloadResult, { status: 'saved' }>> {
  const request = validateRemoteWorkspaceDownloadRequest(input)
  if (!isAbsolute(destinationInput) || destinationInput.includes('\0')) {
    throw new Error('本地保存路径无效')
  }
  const destination = resolve(destinationInput)
  if (activeDestinations.has(destination)) throw new Error('该本地文件正在下载中')
  // Resolve the host only from the saved session/project binding.
  const binding = resolveRemoteWorkspaceHostBinding(
    { sessionId: request.sessionId, projectId: request.projectId },
    dependencies
  )
  const project = (dependencies.getProject ?? getProject)(request.projectId)
  if (project?.location.kind !== 'ssh') throw new Error('远程项目位置无效')
  const hostProfileId = project.location.hostProfileId
  let connectedSession: RemoteSshSession | undefined
  const closeOnAbort = (): void => {
    void connectedSession?.close().catch(() => undefined)
  }
  dependencies.signal?.addEventListener('abort', closeOnAbort, { once: true })
  activeDestinations.add(destination)
  try {
    dependencies.signal?.throwIfAborted()
    return await withAuthorizedRemoteWorkspacePath(
      {
        sessionId: request.sessionId,
        projectId: request.projectId,
        path: request.path,
        mode: 'existing'
      },
      async (authorized, session) => {
        dependencies.signal?.throwIfAborted()
        const currentBinding = resolveRemoteWorkspaceHostBinding(
          { sessionId: request.sessionId, projectId: request.projectId },
          dependencies
        )
        if (currentBinding.cacheKey !== binding.cacheKey) {
          throw new Error('远程项目连接已变化，请重新下载')
        }
        if (authorized.path === authorized.canonicalRoot) throw new Error('只能下载文件')
        // The transfer engine consumes an already authorized path. Keep workspace
        // identities separate from wrapper runs while reusing verified SSH streaming,
        // atomic local publication, retention, hashing, cancellation and progress.
        const transferred = await transferAuthorizedWrapperResult({
          requestId: request.requestId,
          authorized: {
            projectId: authorized.projectId,
            hostProfileId,
            runId: `workspace-session:${authorized.sessionId}`,
            hostAlias: authorized.hostAlias,
            scope: 'run',
            workspaceRoot: authorized.canonicalRoot,
            root: authorized.canonicalRoot,
            path: authorized.path
          },
          session,
          destination,
          agentDir: dependencies.agentDir,
          signal: dependencies.signal,
          targetBefore: await captureWrapperDownloadTarget(destination),
          onProgress: dependencies.onProgress,
          coordinator: dependencies.transferCoordinator
        })
        return {
          status: 'saved',
          path: destination,
          bytes: transferred.bytes,
          sha256: `sha256:${transferred.sha256}`,
          remoteDigestVerified: true
        }
      },
      {
        ...dependencies,
        userInitiated: true,
        execTimeoutMs: 30_000,
        onConnected: (session) => {
          connectedSession = session
          dependencies.onConnected?.(session)
          if (dependencies.signal?.aborted) closeOnAbort()
        }
      }
    )
  } finally {
    dependencies.signal?.removeEventListener('abort', closeOnAbort)
    activeDestinations.delete(destination)
  }
}
