import type { PhiTool } from './engine/types'
import { PHI_REMOTE_BASH_DESCRIPTION } from './engine/phi-extension'

export { PHI_REMOTE_BASH_DESCRIPTION } from './engine/phi-extension'

import type { RemoteBashRequest, RemoteBashResult } from './remote-workspace-bash'
import { remoteWorkspaceToolErrorMessage } from './remote-workspace-tool-error'
import { pickDeclaredToolInput } from './remote-workspace-tool-input'

type BashInput = Pick<RemoteBashRequest, 'command' | 'timeout' | 'cwd' | 'env' | 'pty' | 'async'>

const BASH_PARAMETERS = {
  type: 'object',
  required: ['command'],
  properties: {
    command: { type: 'string' },
    timeout: { type: 'number', minimum: 1, maximum: 120 },
    cwd: { type: 'string' },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    pty: { type: 'boolean' },
    async: { type: 'boolean' }
  },
  additionalProperties: false
} as const

function formatResult(result: RemoteBashResult): string {
  if (result.status === 'unknown') return result.message
  const output = [
    `SSH ${result.hostAlias} · cwd ${result.cwd}`,
    ...(result.stdout ? [`stdout:\n${result.stdout}`] : []),
    ...(result.stderr ? [`stderr:\n${result.stderr}`] : []),
    ...(result.stdoutTruncated ? ['[stdout truncated]'] : []),
    ...(result.stderrTruncated ? ['[stderr truncated]'] : []),
    `Command exited with code ${result.exitCode}`,
    `Wall time: ${result.wallTimeMs} ms`
  ]
  return output.join('\n\n')
}

export function buildRemoteWorkspaceBashTool(
  run: (toolCallId: string, input: BashInput, signal?: AbortSignal) => Promise<RemoteBashResult>
): PhiTool {
  return {
    name: 'bash',
    label: 'Bash',
    description: PHI_REMOTE_BASH_DESCRIPTION,
    site: 'host',
    loadMode: 'essential',
    strict: true,
    parameters: BASH_PARAMETERS,
    approval: 'exec',
    async execute(toolCallId, params, _onUpdate, _ctx, signal) {
      try {
        const input = pickDeclaredToolInput(params, BASH_PARAMETERS)
        if (typeof input.command !== 'string' || !input.command.trim()) {
          throw new Error('请提供远程 Bash 命令')
        }
        const result = await run(toolCallId, input as BashInput, signal)
        return {
          content: [{ type: 'text', text: formatResult(result) }],
          isError: result.status === 'unknown' || result.exitCode !== 0,
          details:
            result.status === 'unknown'
              ? { resultUnknown: true, reason: result.reason, wallTimeMs: result.wallTimeMs }
              : {
                  exitCode: result.exitCode,
                  wallTimeMs: result.wallTimeMs,
                  stdoutTruncated: result.stdoutTruncated,
                  stderrTruncated: result.stderrTruncated,
                  hostAlias: result.hostAlias,
                  cwd: result.cwd
                }
        }
      } catch (error) {
        return {
          content: [
            { type: 'text', text: remoteWorkspaceToolErrorMessage(error, '远程命令未完成') }
          ],
          isError: true
        }
      }
    }
  }
}
