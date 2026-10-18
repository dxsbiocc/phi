import { isRecord } from './common'
import { resolveInsideProject } from './project-path'
import { isXdevDevicePath } from './rpc-xdev'

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'ast_edit', 'ast_grep'])
const SHELL_TOOLS = new Set(['bash', 'powershell'])

// Heredoc bodies are data (often source code), not shell words.
function stripHeredocBodies(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  let terminator: string | null = null
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null
      continue
    }
    kept.push(line)
    const start = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w]*))/.exec(line)
    if (start) terminator = start[1] ?? start[2] ?? start[3]
  }
  return kept.join('\n')
}

// Operators such as Python's `//` or `///` are not paths; a lone `/` (cd /) still is.
function looksLikePath(token: string): boolean {
  return !/^\/{2,}$/.test(token)
}

function toolPaths(toolName: string, input: unknown): string[] {
  if (!isRecord(input)) return []
  const paths: string[] = []
  if (FILE_TOOLS.has(toolName)) {
    for (const key of ['path', 'file_path']) {
      const value = input[key]
      // A canonical xd:// device URL addresses an OMP tool device, not a filesystem location.
      // Whether such a call is admitted is decided by the RPC xdev guards, not by this check.
      if (typeof value === 'string' && !(key === 'path' && isXdevDevicePath(value)))
        paths.push(value)
    }
    if (Array.isArray(input.paths)) {
      paths.push(...input.paths.filter((item): item is string => typeof item === 'string'))
    }
  }
  if (SHELL_TOOLS.has(toolName)) {
    if (typeof input.cwd === 'string') paths.push(input.cwd)
    if (typeof input.command === 'string') {
      const command = stripHeredocBodies(input.command)
      if (/(?:^|[\s'"=<>])\.\.(?=$|[\s'"/])/.test(command)) paths.push('..')
      for (const match of command.matchAll(/(?:^|[\s=<>])((?:\/|~\/|\.\.\/)[^\s'"<>|;&]*)/g)) {
        if (looksLikePath(match[1])) paths.push(match[1])
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
