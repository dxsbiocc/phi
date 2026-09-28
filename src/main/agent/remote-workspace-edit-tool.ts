import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type { RemoteMutationResult } from './remote-workspace-edit'

export const PHI_REMOTE_EDIT_DESCRIPTION =
  'Phi remote project edit (OMP replace mode): change an existing UTF-8 file on the selected SSH server. Read the file first, then pass path, old_string, new_string, and optional replace_all. A changed or unread file is refused.'

export type RemoteEditToolResult = RemoteMutationResult & {
  diff?: string
  firstChangedLine?: number
}

export function buildRemoteWorkspaceEditTool(
  edit: (
    toolCallId: string,
    input: { path: string; old_string: string; new_string: string; replace_all?: boolean },
    signal?: AbortSignal
  ) => Promise<RemoteEditToolResult>
): CustomTool {
  return {
    name: 'edit',
    label: 'Edit',
    description: PHI_REMOTE_EDIT_DESCRIPTION,
    loadMode: 'essential',
    strict: true,
    parameters: {
      type: 'object',
      required: ['path', 'old_string', 'new_string'],
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      additionalProperties: false
    },
    approval: 'write',
    async execute(toolCallId, params, _onUpdate, _ctx, signal) {
      try {
        const input = params as Record<string, unknown>
        if (
          typeof input.path !== 'string' ||
          !input.path ||
          typeof input.old_string !== 'string' ||
          typeof input.new_string !== 'string'
        ) {
          throw new Error('请提供远程路径、old_string 和 new_string')
        }
        const result = await edit(
          toolCallId,
          input as {
            path: string
            old_string: string
            new_string: string
            replace_all?: boolean
          },
          signal
        )
        if (result.status === 'unknown') {
          return {
            content: [{ type: 'text', text: result.message }],
            isError: true,
            details: { resultUnknown: true }
          }
        }
        if (result.status !== 'updated') throw new Error('远程 edit 不能新建文件')
        return {
          content: [{ type: 'text', text: `Edited remote file ${result.path}` }],
          details: {
            path: result.path,
            resolvedPath: result.path,
            diff: result.diff ?? '',
            ...(result.firstChangedLine === undefined
              ? {}
              : { firstChangedLine: result.firstChangedLine }),
            oldText: result.oldText,
            newText: result.newText
          }
        }
      } catch (error) {
        return {
          content: [
            { type: 'text', text: error instanceof Error ? error.message : '远程编辑未完成' }
          ],
          isError: true
        }
      }
    }
  }
}
