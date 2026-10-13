import type { PhiTool } from './engine/types'

import type { RemoteWorkspaceReadResult } from './remote-workspace-read'
import { remoteWorkspaceToolErrorMessage } from './remote-workspace-tool-error'

export const PHI_REMOTE_READ_DESCRIPTION =
  'Phi remote project read: read one UTF-8 file or list one directory on the selected SSH server, or read an enabled global Skill through skill://. Project paths run on the server; Skill resources are restricted to the loaded Skill root. Raw ssh:// URLs are not supported; line selectors such as path:10-50 match local read syntax.'

type RemoteReadOptions = {
  readResource?: (path: string) => RemoteWorkspaceReadResult | Promise<RemoteWorkspaceReadResult>
}

export function buildRemoteWorkspaceReadTool(
  read: (path: string) => Promise<RemoteWorkspaceReadResult>,
  options: RemoteReadOptions = {}
): PhiTool {
  return {
    name: 'read',
    label: 'Read',
    description: PHI_REMOTE_READ_DESCRIPTION,
    site: 'host',
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
        if (typeof params !== 'object' || params === null || Array.isArray(params)) {
          throw new Error('远程 read 只接受 path 字段')
        }
        const input = params as Record<string, unknown>
        if (Object.keys(input).some((key) => key !== 'path')) {
          throw new Error('远程 read 只接受 path 字段')
        }
        if (typeof input.path !== 'string' || !input.path) {
          throw new Error('请提供远程项目内路径')
        }
        const result = input.path.startsWith('skill://')
          ? await readResource(input.path, options)
          : await read(input.path)
        if (result.kind === 'image') {
          return {
            content: [
              {
                type: 'text',
                text: `Image: ${result.path} (${result.fileSize} bytes)`
              },
              { type: 'image', data: result.data, mimeType: result.contentType }
            ],
            details: {
              resolvedPath: result.path,
              kind: 'file',
              fileSize: result.fileSize,
              contentType: result.contentType
            }
          }
        }
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

function readResource(
  path: string,
  options: RemoteReadOptions
): Promise<RemoteWorkspaceReadResult> {
  if (!options.readResource) {
    return Promise.reject(new Error('远程会话没有加载该 Skill 资源'))
  }
  return Promise.resolve(options.readResource(path))
}
