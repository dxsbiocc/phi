export type TaskEventIntent =
  | { kind: 'new-task' }
  | { kind: 'independent-run'; text: string }
  | { kind: 'list' }
  | { kind: 'status' | 'cancel' | 'approve' | 'deny'; target?: string; approvalId?: string }
  | { kind: 'supplement'; target?: string; text: string }
  | { kind: 'clarify' }

type TaskControlKind = 'status' | 'cancel' | 'approve' | 'deny'

function isControlKind(value: string): value is TaskControlKind {
  return value === 'status' || value === 'cancel' || value === 'approve' || value === 'deny'
}

function controlIntent(kind: TaskControlKind, target?: string): TaskEventIntent {
  if (target === undefined) return { kind }
  return { kind, target }
}

function isHexCharacter(character: string): boolean {
  return (
    (character >= '0' && character <= '9') ||
    (character >= 'a' && character <= 'f') ||
    (character >= 'A' && character <= 'F')
  )
}

function isV4Variant(character: string): boolean {
  return character === '8' || character === '9' || character === 'a' || character === 'b'
}

function isTaskSelector(value: string): boolean {
  const length = value.length
  if (length < 8 || length > 36) return false

  for (let index = 0; index < length; index += 1) {
    const character = value.charAt(index)
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (character !== '-') return false
    } else if (!isHexCharacter(character)) {
      return false
    }
  }

  const normalized = value.toLowerCase()
  if (length > 14 && normalized.charAt(14) !== '4') return false
  if (length > 19 && !isV4Variant(normalized.charAt(19))) return false
  return true
}

function isApprovalSelector(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,256}$/.test(value)
}

function parseControlAction(kind: TaskControlKind, argumentText: string): TaskEventIntent {
  const trimmed = argumentText.trim()
  if (trimmed === '') return controlIntent(kind)

  if (/[\r\n\v\f\u2028\u2029]/u.test(argumentText)) return { kind: 'clarify' }
  const [target, approvalId, ...extra] = trimmed.split(/[ \t]+/)
  if (!target || !isTaskSelector(target) || extra.length) return { kind: 'clarify' }
  if (!approvalId) return controlIntent(kind, target)
  if (
    (kind !== 'approve' && kind !== 'deny') ||
    target.length !== 36 ||
    !isApprovalSelector(approvalId)
  ) {
    return { kind: 'clarify' }
  }
  return { kind, target, approvalId }
}

function parseAddAction(argumentText: string): TaskEventIntent {
  const trimmed = argumentText.trim()
  if (trimmed === '') return { kind: 'clarify' }

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (match === null) return { kind: 'clarify' }

  const target = match[1]
  const instruction = (match[2] ?? '').trim()
  if (target === undefined || !isTaskSelector(target) || instruction === '') {
    return { kind: 'clarify' }
  }

  return { kind: 'supplement', target, text: instruction }
}

function parseTaskActions(argumentText: string): TaskEventIntent {
  const match = /^([a-z]+)(?:[ \t]+([\s\S]*))?$/i.exec(argumentText)
  if (match === null) return { kind: 'clarify' }

  const action = (match[1] ?? '').toLowerCase()
  const actionArguments = match[2] ?? ''

  if (isControlKind(action)) {
    return parseControlAction(action, actionArguments)
  }

  if (action === 'add') return parseAddAction(actionArguments)

  if (action === 'run') {
    const text = actionArguments.trim()
    return text === '' ? { kind: 'clarify' } : { kind: 'independent-run', text }
  }

  return { kind: 'clarify' }
}

function parseTaskCommand(text: string): TaskEventIntent | undefined {
  const trimmed = text.trim()
  const match = /^\/(task|tasks)(?=\s|$)/i.exec(trimmed)
  if (match === null) return undefined

  const namespace = match[1]
  const command = match[0]
  if (namespace === undefined || command === undefined) return undefined

  const rest = trimmed.slice(command.length)
  if (namespace.toLowerCase() === 'tasks') {
    return rest.trim() === '' ? { kind: 'list' } : { kind: 'clarify' }
  }

  if (!/^[ \t]+[^\s]/.test(rest)) return { kind: 'clarify' }
  return parseTaskActions(rest.trim())
}

function parseEnglishNaturalTaskEvent(text: string): TaskEventIntent | undefined {
  const targetedMatch =
    /^(status of|cancel|approve|deny)[ \t]+task[ \t]+([0-9a-fA-F-]{8,36})$/i.exec(text)

  if (targetedMatch !== null) {
    const action = (targetedMatch[1] ?? '').toLowerCase()
    const target = targetedMatch[2]
    if (target !== undefined && isTaskSelector(target)) {
      const kind = action === 'status of' ? 'status' : action
      if (isControlKind(kind)) return controlIntent(kind, target)
    }
  }

  const supplementMatch =
    /^add[ \t]+to[ \t]+task[ \t]+([0-9a-fA-F-]{8,36})[ \t]*[:：][ \t]*([\s\S]+)$/i.exec(text)

  if (supplementMatch !== null) {
    const target = supplementMatch[1]
    const instruction = (supplementMatch[2] ?? '').trim()
    if (target !== undefined && isTaskSelector(target) && instruction !== '') {
      return { kind: 'supplement', target, text: instruction }
    }
  }

  if (/^status of[ \t]+(?:the|this|that)[ \t]+task$/i.test(text)) {
    return { kind: 'status' }
  }

  const ambiguousSupplement =
    /^add[ \t]+to[ \t]+(?:the|this|that)[ \t]+task[ \t]*[:：][ \t]*([\s\S]+)$/i.exec(text)
  if (ambiguousSupplement?.[1]?.trim()) {
    return { kind: 'supplement', text: ambiguousSupplement[1].trim() }
  }

  const ambiguousMatch = /^(cancel|approve|deny)[ \t]+(?:(?:the|this|that)[ \t]+)?task$/i.exec(text)

  if (ambiguousMatch !== null) {
    const action = (ambiguousMatch[1] ?? '').toLowerCase()
    if (isControlKind(action)) return controlIntent(action)
  }

  if (/^(?:status of|cancel|approve|deny)[ \t]+task[ \t]+[^\s]+$/i.test(text)) {
    return { kind: 'clarify' }
  }
  return undefined
}

function chineseControlKind(value: string): TaskControlKind | undefined {
  if (value === '取消' || value === '停止') return 'cancel'
  if (value === '批准') return 'approve'
  if (value === '拒绝') return 'deny'
  return undefined
}

function parseChineseNaturalTaskEvent(text: string): TaskEventIntent | undefined {
  const statusMatch = /^(?:查询|查看)任务[ \t]*([0-9a-fA-F-]{8,36})[ \t]*的状态$/.exec(text)

  if (statusMatch !== null) {
    const target = statusMatch[1]
    if (target !== undefined && isTaskSelector(target)) {
      return controlIntent('status', target)
    }
  }

  const targetedMatch = /^(取消|停止|批准|拒绝)任务[ \t]*([0-9a-fA-F-]{8,36})$/.exec(text)

  if (targetedMatch !== null) {
    const kind = chineseControlKind(targetedMatch[1] ?? '')
    const target = targetedMatch[2]
    if (kind !== undefined && target !== undefined && isTaskSelector(target)) {
      return controlIntent(kind, target)
    }
  }

  const supplementMatch = /^补充任务\s*([0-9a-fA-F-]{8,36})\s*[：:]\s*([\s\S]+)$/.exec(text)

  if (supplementMatch !== null) {
    const target = supplementMatch[1]
    const supplementText = (supplementMatch[2] ?? '').trim()
    if (target !== undefined && isTaskSelector(target) && supplementText !== '') {
      return { kind: 'supplement', target, text: supplementText }
    }
  }

  const ambiguousSupplement =
    /^补充(?:这个|那个|该|此|上一个|刚才的)?任务[ \t]*[:：][ \t]*([\s\S]+)$/.exec(text)
  if (ambiguousSupplement?.[1]?.trim()) {
    return { kind: 'supplement', text: ambiguousSupplement[1].trim() }
  }

  const ambiguousMatch = /^(取消|停止|批准|拒绝)(?:这个|那个|该|此|上一个|刚才的)?任务$/.exec(text)

  if (ambiguousMatch !== null) {
    const kind = chineseControlKind(ambiguousMatch[1] ?? '')
    if (kind !== undefined) return controlIntent(kind)
  }

  if (/^(?:查看|查询)(?:这个|那个|该|此|上一个|刚才的)?任务状态$/.test(text))
    return { kind: 'status' }
  if (/^(?:取消|停止|批准|拒绝)任务[ \t]+[^\s]+$/.test(text)) return { kind: 'clarify' }

  return undefined
}

function parseNaturalTaskEvent(text: string): TaskEventIntent | undefined {
  return parseEnglishNaturalTaskEvent(text) ?? parseChineseNaturalTaskEvent(text)
}

export function parseTaskEvent(text: string): TaskEventIntent {
  const commandIntent = parseTaskCommand(text)
  if (commandIntent !== undefined) return commandIntent

  const normalized = text.trim()
  if (normalized === '') return { kind: 'new-task' }

  return parseNaturalTaskEvent(normalized) ?? { kind: 'new-task' }
}

export function resolveTaskTargets<T extends { id: string }>(
  candidates: readonly T[],
  target?: string
): T[] {
  if (target === undefined) return candidates.slice()
  if (!isTaskSelector(target)) return []

  const normalized = target.toLowerCase()
  return candidates.filter((candidate) => candidate.id.toLowerCase().startsWith(normalized))
}
