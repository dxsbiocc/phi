import type { PhiTool } from './engine/types'
import { PHI_REMOTE_WRITE_DESCRIPTION } from './engine/phi-extension'

export { PHI_REMOTE_WRITE_DESCRIPTION } from './engine/phi-extension'

import type { RemoteMutationResult } from './remote-workspace-edit'
import { remoteWorkspaceToolErrorMessage } from './remote-workspace-tool-error'

export function buildRemoteWorkspaceWriteTool(
  create: (
    toolCallId: string,
    path: string,
    content: string,
    signal?: AbortSignal
  ) => Promise<RemoteMutationResult>
): PhiTool {
  return {
    name: 'write',
    label: 'Write',
    description: PHI_REMOTE_WRITE_DESCRIPTION,
    site: 'host',
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
            { type: 'text', text: remoteWorkspaceToolErrorMessage(error, '远程新建文件未完成') }
          ],
          isError: true
        }
      }
    }
  }
}
