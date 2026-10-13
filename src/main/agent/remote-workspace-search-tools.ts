import type { PhiTool } from './engine/types'
import { PHI_REMOTE_GLOB_DESCRIPTION, PHI_REMOTE_GREP_DESCRIPTION } from './engine/phi-extension'

export { PHI_REMOTE_GLOB_DESCRIPTION, PHI_REMOTE_GREP_DESCRIPTION } from './engine/phi-extension'

import type {
  RemoteGlobRequest,
  RemoteGlobResult,
  RemoteGrepRequest,
  RemoteGrepResult
} from './remote-workspace-search'
import { remoteWorkspaceToolErrorMessage } from './remote-workspace-tool-error'
import { pickDeclaredToolInput } from './remote-workspace-tool-input'

type GlobInput = Pick<RemoteGlobRequest, 'path' | 'hidden' | 'gitignore' | 'limit'>
type GrepInput = Pick<RemoteGrepRequest, 'pattern' | 'path' | 'case' | 'gitignore' | 'skip'>

const GLOB_PARAMETERS = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    hidden: { type: 'boolean' },
    gitignore: { type: 'boolean' },
    limit: { type: 'number' }
  },
  additionalProperties: false
} as const

const GREP_PARAMETERS = {
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
} as const

export function buildRemoteWorkspaceGlobTool(
  run: (input: GlobInput) => Promise<RemoteGlobResult>
): PhiTool {
  return {
    name: 'glob',
    label: 'Glob',
    description: PHI_REMOTE_GLOB_DESCRIPTION,
    site: 'host',
    loadMode: 'essential',
    strict: true,
    parameters: GLOB_PARAMETERS,
    approval: 'read',
    async execute(_toolCallId, params) {
      try {
        const result = await run(pickDeclaredToolInput(params, GLOB_PARAMETERS) as GlobInput)
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
            { type: 'text', text: remoteWorkspaceToolErrorMessage(error, '远程 glob 未完成') }
          ],
          isError: true
        }
      }
    }
  }
}

export function buildRemoteWorkspaceGrepTool(
  run: (input: GrepInput) => Promise<RemoteGrepResult>
): PhiTool {
  return {
    name: 'grep',
    label: 'Grep',
    description: PHI_REMOTE_GREP_DESCRIPTION,
    site: 'host',
    loadMode: 'essential',
    strict: true,
    parameters: GREP_PARAMETERS,
    approval: 'read',
    async execute(_toolCallId, params) {
      try {
        const input = pickDeclaredToolInput(params, GREP_PARAMETERS)
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
            { type: 'text', text: remoteWorkspaceToolErrorMessage(error, '远程 grep 未完成') }
          ],
          isError: true
        }
      }
    }
  }
}
