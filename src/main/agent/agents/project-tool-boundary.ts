import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { resolveInsideProject } from '../project-path'

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'ast_edit', 'ast_grep'])
const SHELL_TOOLS = new Set(['bash', 'powershell'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolPaths(toolName: string, input: unknown): string[] {
  if (!isRecord(input)) return []
  const paths: string[] = []
  if (FILE_TOOLS.has(toolName)) {
    for (const key of ['path', 'file_path']) {
      if (typeof input[key] === 'string') paths.push(input[key])
    }
    if (Array.isArray(input.paths)) {
      paths.push(...input.paths.filter((item): item is string => typeof item === 'string'))
    }
  }
  if (SHELL_TOOLS.has(toolName)) {
    if (typeof input.cwd === 'string') paths.push(input.cwd)
    if (typeof input.command === 'string') {
      if (/(?:^|[\s'"=<>])\.\.(?=$|[\s'"/])/.test(input.command)) paths.push('..')
      // Catch explicit absolute and parent-relative paths, including shell redirection targets.
      for (const match of input.command.matchAll(
        /(?:^|[\s=<>])((?:\/|~\/|\.\.\/)[^\s'"<>|;&]*)/g
      )) {
        paths.push(match[1])
      }
    }
  }
  return paths
}

export function projectToolBoundaryDecision(
  cwd: string,
  toolName: string,
  input: unknown
): { allowed: boolean; reason?: string } {
  for (const path of toolPaths(toolName, input)) {
    if (path.startsWith('~/')) {
      return { allowed: false, reason: `Path ${path} is outside the current project (${cwd}).` }
    }
    const resolved = resolveInsideProject(cwd, path, 'Tool path')
    if (!resolved.ok) return { allowed: false, reason: resolved.error }
  }
  return { allowed: true }
}

export function createProjectToolBoundaryExtension(cwd: string): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = projectToolBoundaryDecision(cwd, event.toolName, event.input)
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}
