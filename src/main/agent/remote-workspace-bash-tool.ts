import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type { RemoteBashRequest, RemoteBashResult } from './remote-workspace-bash'

export const PHI_REMOTE_BASH_DESCRIPTION =
  'Phi remote project bash: execute a bounded non-interactive Bash command on the selected SSH server with cwd fixed to the project root. A shell command can access paths outside that root. Use Wrapper for long-running Nextflow or Slurm jobs. PTY and async mode are unavailable.'

type BashInput = Pick<RemoteBashRequest, 'command' | 'timeout' | 'cwd' | 'env' | 'pty' | 'async'>

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
): CustomTool {
  return {
    name: 'bash',
    label: 'Bash',
    description: PHI_REMOTE_BASH_DESCRIPTION,
    loadMode: 'essential',
    strict: true,
    parameters: {
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
    },
    approval: 'exec',
    async execute(toolCallId, params, _onUpdate, _ctx, signal) {
      try {
        const input = params as Record<string, unknown>
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
            { type: 'text', text: error instanceof Error ? error.message : '远程命令未完成' }
          ],
          isError: true
        }
      }
    }
  }
}
