import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type { RemoteMutationResult } from './remote-workspace-edit'

export const PHI_REMOTE_WRITE_DESCRIPTION =
  'Phi remote project write: create a UTF-8 file, or replace an existing file that this conversation already read and that has not changed. Pass path and content. Existing directories and special files are refused.'

export function buildRemoteWorkspaceWriteTool(
  create: (
    toolCallId: string,
    path: string,
    content: string,
    signal?: AbortSignal
  ) => Promise<RemoteMutationResult>
): CustomTool {
  return {
    name: 'write',
    label: 'Write',
    description: PHI_REMOTE_WRITE_DESCRIPTION,
    loadMode: 'essential',
    strict: true,
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      additionalProperties: false
    },
    approval: 'write',
    async execute(toolCallId, params, _onUpdate, _ctx, signal) {
      try {
        const input = params as Record<string, unknown>
        if (typeof input.path !== 'string' || !input.path || typeof input.content !== 'string') {
          throw new Error('请提供远程项目内路径和文本内容')
        }
        const result = await create(toolCallId, input.path, input.content, signal)
        return result.status === 'created' || result.status === 'updated'
          ? {
              content: [
                {
                  type: 'text',
                  text: `${result.status === 'created' ? 'Created' : 'Updated'} remote file ${result.path} (${result.bytes} bytes)`
                }
              ],
              details: { resolvedPath: result.path, bytes: result.bytes }
            }
          : {
              content: [{ type: 'text', text: result.message }],
              isError: true,
              details: { resultUnknown: true }
            }
      } catch (error) {
        return {
          content: [
            { type: 'text', text: error instanceof Error ? error.message : '远程新建文件未完成' }
          ],
          isError: true
        }
      }
    }
  }
}
