import { resolveLocalPath } from './localPaths'

const TARGET_TOOLS = new Set(['edit', 'write'])
const TARGET_KEYS = ['path', 'file_path']

export type ToolTarget = {
  label: string
  absolutePath: string
}

export function toolTargetFromArgs(
  toolName: string,
  argsJson: string | undefined,
  cwd: string
): ToolTarget | null {
  if (!TARGET_TOOLS.has(toolName) || !argsJson) return null

  let args: unknown
  try {
    args = JSON.parse(argsJson)
  } catch {
    return null
  }
  if (!args || typeof args !== 'object') return null

  const record = args as Record<string, unknown>
  const label = TARGET_KEYS.map((key) => record[key]).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  )
  if (!label) return null

  const absolutePath = resolveLocalPath(label, cwd)
  return absolutePath ? { label, absolutePath } : null
}
