import { randomUUID } from 'node:crypto'
import { editDiffString } from '@oh-my-pi/pi-natives'

import { buildRemoteWorkspaceBashTool } from '../remote-workspace-bash-tool'
import type { RemoteBashResult } from '../remote-workspace-bash'
import type { RemoteMutationResult } from '../remote-workspace-edit'
import { buildRemoteWorkspaceEditTool } from '../remote-workspace-edit-tool'
import type { RemoteWorkspaceReadResult } from '../remote-workspace-read'
import { buildRemoteWorkspaceReadTool } from '../remote-workspace-read-tool'
import type { RemoteGlobResult, RemoteGrepResult } from '../remote-workspace-search'
import {
  buildRemoteWorkspaceGlobTool,
  buildRemoteWorkspaceGrepTool
} from '../remote-workspace-search-tools'
import { buildRemoteWorkspaceWriteTool } from '../remote-workspace-write-tool'
import type { PhiTool } from './types'

export type RemoteWorkspaceHostRequest = (method: string, params: unknown) => Promise<unknown>

/**
 * The Phi session and project a remote conversation's file and command requests belong to.
 * Forwarded unchecked; the main process validates both before touching a host.
 */
export interface RemoteWorkspaceIdentity {
  sessionId: unknown
  projectId: unknown
}

export function buildRemoteWorkspaceRead(
  requestHost: RemoteWorkspaceHostRequest,
  identity: RemoteWorkspaceIdentity
): (path: string) => Promise<RemoteWorkspaceReadResult> {
  return async (path) =>
    (await requestHost('remoteWorkspace.read', {
      sessionId: identity.sessionId,
      projectId: identity.projectId,
      path
    })) as RemoteWorkspaceReadResult
}

/**
 * The six same-name file and command tools of a remote project conversation. Each one sends
 * its request to the main process, which runs it on the project's SSH host.
 */
export function buildRemoteWorkspaceCustomTools(
  requestHost: RemoteWorkspaceHostRequest,
  identity: RemoteWorkspaceIdentity,
  options: {
    read: (path: string) => Promise<RemoteWorkspaceReadResult>
    readResource: (path: string) => RemoteWorkspaceReadResult | Promise<RemoteWorkspaceReadResult>
  }
): PhiTool[] {
  const requestIdentity = (): RemoteWorkspaceIdentity & { requestId: string } => ({
    sessionId: identity.sessionId,
    projectId: identity.projectId,
    requestId: randomUUID()
  })
  return [
    buildRemoteWorkspaceEditTool(async (toolCallId, input, signal) => {
      if (signal?.aborted) throw new Error('远程编辑在提交前已取消')
      const ids = requestIdentity()
      const cancel = (): void => {
        void requestHost('remoteWorkspace.cancelEdit', ids).catch(() => undefined)
      }
      const pending = requestHost('remoteWorkspace.edit', {
        ...ids,
        toolCallId,
        ...input
      })
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      try {
        const result = (await pending) as RemoteMutationResult
        if (result.status !== 'updated') return result
        const preview = editDiffString(result.oldText, result.newText, result.path)
        return { ...result, ...preview }
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    }),
    buildRemoteWorkspaceWriteTool(async (toolCallId, path, content, signal) => {
      if (signal?.aborted) throw new Error('远程写入在提交前已取消')
      const ids = requestIdentity()
      const cancel = (): void => {
        void requestHost('remoteWorkspace.cancelWrite', ids).catch(() => undefined)
      }
      const pending = requestHost('remoteWorkspace.write', {
        ...ids,
        toolCallId,
        path,
        content
      })
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      try {
        return (await pending) as RemoteMutationResult
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    }),
    buildRemoteWorkspaceReadTool(options.read, { readResource: options.readResource }),
    buildRemoteWorkspaceGlobTool(
      async (input) =>
        (await requestHost('remoteWorkspace.glob', {
          ...input,
          sessionId: identity.sessionId,
          projectId: identity.projectId
        })) as RemoteGlobResult
    ),
    buildRemoteWorkspaceGrepTool(
      async (input) =>
        (await requestHost('remoteWorkspace.grep', {
          ...input,
          sessionId: identity.sessionId,
          projectId: identity.projectId
        })) as RemoteGrepResult
    ),
    buildRemoteWorkspaceBashTool(async (toolCallId, input, signal) => {
      if (signal?.aborted) throw new Error('远程命令在提交前已取消')
      const ids = requestIdentity()
      const cancel = (): void => {
        void requestHost('remoteWorkspace.cancelBash', ids).catch(() => undefined)
      }
      const pending = requestHost('remoteWorkspace.bash', {
        ...input,
        ...ids,
        toolCallId
      })
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      try {
        return (await pending) as RemoteBashResult
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    })
  ]
}
