const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'find', 'ls', 'todo', 'ask_user_question'])

export function planModeToolDecision(
  active: boolean,
  toolName: string,
  input: unknown
): { allowed: boolean; reason?: string } {
  if (!active) return { allowed: true }
  if (READ_ONLY_TOOLS.has(toolName)) return { allowed: true }
  const path =
    input && typeof input === 'object' && typeof (input as { path?: unknown }).path === 'string'
      ? (input as { path: string }).path
      : ''
  const targetPath = /^\[([^\]#]+)(?:#[A-Fa-f0-9]{4})?\]$/.exec(path)?.[1] ?? path
  if (
    toolName === 'write' &&
    (targetPath.startsWith('local://') || targetPath === 'xd://propose')
  ) {
    return { allowed: true }
  }
  if (toolName === 'edit' && targetPath.startsWith('local://')) return { allowed: true }
  return { allowed: false, reason: '计划评审前只能读取工作区并修改会话内的计划草稿。' }
}
