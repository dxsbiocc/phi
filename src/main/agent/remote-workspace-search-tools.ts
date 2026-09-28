import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import type {
  RemoteGlobRequest,
  RemoteGlobResult,
  RemoteGrepRequest,
  RemoteGrepResult
} from './remote-workspace-search'

export const PHI_REMOTE_GLOB_DESCRIPTION =
  'Phi remote project glob: find files on the selected SSH server within the project root. Pass path, hidden, gitignore, and limit as in the local glob tool. Raw ssh:// URLs are not accepted.'

export const PHI_REMOTE_GREP_DESCRIPTION =
  'Phi remote project grep: search file contents on the selected SSH server within the project root. Pass pattern, path, case, gitignore, and skip as in the local grep tool. Raw ssh:// URLs are not accepted.'

type GlobInput = Pick<RemoteGlobRequest, 'path' | 'hidden' | 'gitignore' | 'limit'>
type GrepInput = Pick<RemoteGrepRequest, 'pattern' | 'path' | 'case' | 'gitignore' | 'skip'>

export function buildRemoteWorkspaceGlobTool(
  run: (input: GlobInput) => Promise<RemoteGlobResult>
): CustomTool {
  return {
    name: 'glob',
    label: 'Glob',
    description: PHI_REMOTE_GLOB_DESCRIPTION,
    loadMode: 'essential',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        hidden: { type: 'boolean' },
        gitignore: { type: 'boolean' },
        limit: { type: 'number' }
      },
      additionalProperties: false
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      try {
        const result = await run(params as GlobInput)
        return {
          content: [{ type: 'text', text: result.content }],
          details: {
            files: result.paths,
            fileCount: result.paths.length,
            truncated: result.truncated,
            engine: result.engine,
            gitignoreApplied: result.gitignoreApplied
          }
        }
      } catch (error) {
        return {
          content: [
            { type: 'text', text: error instanceof Error ? error.message : '远程 glob 未完成' }
          ],
          isError: true
        }
      }
    }
  }
}

export function buildRemoteWorkspaceGrepTool(
  run: (input: GrepInput) => Promise<RemoteGrepResult>
): CustomTool {
  return {
    name: 'grep',
    label: 'Grep',
    description: PHI_REMOTE_GREP_DESCRIPTION,
    loadMode: 'essential',
    strict: true,
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        case: { type: 'boolean' },
        gitignore: { type: 'boolean' },
        skip: { type: ['number', 'null'] }
      },
      additionalProperties: false
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      try {
        const input = params as Record<string, unknown>
        if (typeof input.pattern !== 'string' || !input.pattern.trim()) {
          throw new Error('请提供远程 grep 正则表达式')
        }
        const result = await run(input as GrepInput)
        return {
          content: [{ type: 'text', text: result.content }],
          details: {
            matchCount: result.matchCount,
            fileCount: result.fileCount,
            files: [...new Set(result.matches.map((match) => match.path))],
            truncated: result.truncated,
            engine: result.engine,
            gitignoreApplied: result.gitignoreApplied
          }
        }
      } catch (error) {
        return {
          content: [
            { type: 'text', text: error instanceof Error ? error.message : '远程 grep 未完成' }
          ],
          isError: true
        }
      }
    }
  }
}
