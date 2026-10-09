import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type { RemoteWorkspaceReadResult } from './remote-workspace-read'
import { remoteWorkspaceToolErrorMessage } from './remote-workspace-tool-error'

export const PHI_REMOTE_READ_DESCRIPTION =
  'Phi remote project read: read one UTF-8 file or list one directory on the selected SSH server. Pass a project-relative or project-absolute path; raw ssh:// URLs and inline selectors are not supported.'

export function buildRemoteWorkspaceReadTool(
  read: (path: string) => Promise<RemoteWorkspaceReadResult>
): CustomTool {
  return {
    name: 'read',
    label: 'Read',
    description: PHI_REMOTE_READ_DESCRIPTION,
    loadMode: 'essential',
    strict: true,
    parameters: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
      additionalProperties: false
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      try {
        const input = params as Record<string, unknown>
        if (typeof input.path !== 'string' || !input.path) throw new Error('请提供远程项目内路径')
        const result = await read(input.path)
        return {
          content: [{ type: 'text', text: result.content }],
          details: {
            resolvedPath: result.path,
            ...(result.kind === 'directory'
              ? { isDirectory: true }
              : { kind: 'file', fileSize: result.fileSize, contentType: result.contentType })
          }
        }
      } catch (error) {
        return {
          content: [
            { type: 'text', text: remoteWorkspaceToolErrorMessage(error, '远程读取未完成') }
          ],
          isError: true
        }
      }
    }
  }
}
