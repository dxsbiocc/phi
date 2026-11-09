const READ_ONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'find',
  'ls',
  'todo',
  'ask',
  'ask_user_question',
  'capability_search',
  'find_skills',
  'check_environment',
  'propose_plan_steps'
])

const STRUCTURED_PLAN_TOOL_REASON =
  '计划评审前只能读取工作区，并调用 propose_plan_steps 提交结构化计划。'
const PLAN_MODE_CONTEXT_TYPE = 'plan-mode-context'
const PLAN_MODE_REMINDER_MARKER = 'Plan mode turn ended without a required tool call.'
const STRUCTURED_PLAN_REMINDER = `<system-reminder>
Plan review turn ended without a required tool call.

You MUST call \`propose_plan_steps\` now with the complete structured plan, or call \`ask\` if clarification is genuinely required. Never output plain text in this turn.
</system-reminder>`

function promptRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function textParts(message: Record<string, unknown>): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((part) => {
    const block = promptRecord(part)
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  })
}

function structuredPlanReminder<T>(message: T, record: Record<string, unknown>): T {
  if (!Array.isArray(record.content)) return message
  return {
    ...record,
    content: record.content.map((part) => {
      const block = promptRecord(part)
      return block?.type === 'text' && typeof block.text === 'string'
        ? { ...block, text: STRUCTURED_PLAN_REMINDER }
        : part
    })
  } as T
}

/**
 * OMP injects its markdown-plan prompt whenever plan mode is enabled. Structured
 * plan-and-execute mode keeps OMP's read-only/enforcement state but must not send
 * the model the markdown/xd://propose instructions, so the prompt context is
 * replaced with the Phi structured-plan instructions instead.
 */
export function suppressPlanExecutePromptContext<T>(messages: readonly T[]): T[] | undefined {
  let changed = false
  const next: T[] = []
  for (const message of messages) {
    const record = promptRecord(message)
    if (record?.role === 'custom' && record.customType === PLAN_MODE_CONTEXT_TYPE) {
      changed = true
      continue
    }
    if (
      record?.role === 'developer' &&
      textParts(record).some((text) => text.includes(PLAN_MODE_REMINDER_MARKER))
    ) {
      changed = true
      next.push(structuredPlanReminder(message, record))
      continue
    }
    next.push(message)
  }
  return changed ? next : undefined
}

export function planModeToolDecision(
  active: boolean,
  toolName: string,
  input: unknown,
  structured = false
): { allowed: boolean; reason?: string } {
  if (!active) return { allowed: true }
  if (READ_ONLY_TOOLS.has(toolName)) return { allowed: true }
  if (structured) return { allowed: false, reason: STRUCTURED_PLAN_TOOL_REASON }
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
