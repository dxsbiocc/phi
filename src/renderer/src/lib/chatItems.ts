import type { ChatItem, NotebookToolSummary, RunLifecycleItem } from '../types'

const WRAPPER_TOOL_PREFIX = 'wrapper.'
const NOTEBOOK_TOOL_PREFIX = 'notebook.'

/**
 * `wrapper.search`/`wrapper.inspect` (see src/main/agent/wrappers/tools.ts)
 * are read-only lookups — they never return `details.kind === 'wrapper_plan'`,
 * so a `WrapperPlanItem` built for one would never get a `planId` and
 * WrapperPlanCard's `!item.planId || !plan` branch would show "正在加载计划…"
 * forever instead of the actual search/inspect result. Both share the
 * `wrapper.` prefix with real execute tools (`wrapperToolName()` sanitizes
 * a canonical id into `wrapper.<id-with-slashes-as-underscores>`, which
 * can't collide with these two fixed names), so they need an explicit
 * exclusion rather than a prefix check alone.
 */
const WRAPPER_NON_PLAN_TOOL_NAMES = new Set(['wrapper.search', 'wrapper.inspect'])

/**
 * `wrapper.<id>` execute tool calls render as a `WrapperPlanItem` (a plan
 * card), not a generic `ToolCallItem` — see docs/design/phi-wrapper-
 * technical-design.md, "Chat And UI Integration". `wrapper.search`/
 * `wrapper.inspect` are excluded — see `WRAPPER_NON_PLAN_TOOL_NAMES`.
 */
export function isWrapperToolName(toolName: string): boolean {
  return toolName.startsWith(WRAPPER_TOOL_PREFIX) && !WRAPPER_NON_PLAN_TOOL_NAMES.has(toolName)
}

export function isNotebookToolName(toolName: string): boolean {
  return toolName.startsWith(NOTEBOOK_TOOL_PREFIX)
}

/**
 * Convention for `wrapper.<id>` tool results (Milestone P1.8): the tool
 * returns `{ content: [...], details: { kind: 'wrapper_plan', planId } }`.
 * Large plan metadata never travels through the chat event stream — only
 * the id, which the card uses to load full detail from the wrapper store.
 */
export function extractWrapperPlanId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return undefined
  const record = details as { kind?: unknown; planId?: unknown }
  if (record.kind !== 'wrapper_plan' || typeof record.planId !== 'string') return undefined
  return record.planId
}

function detailsFromToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined
  const record = result as { details?: unknown }
  return record.details ?? result
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

function numberOrNullField(
  record: Record<string, unknown>,
  key: string
): number | null | undefined {
  const value = record[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = numberOrNullField(record, key)
  return typeof value === 'number' ? value : undefined
}

function notebookCellNumberFrom(
  record: Record<string, unknown>,
  cell: Record<string, unknown> | null
): number | undefined {
  const explicit =
    numberField(record, 'cellNumber') ??
    (cell ? (numberField(cell, 'cellNumber') ?? numberField(cell, 'number')) : undefined)
  if (explicit !== undefined && explicit >= 1) return Math.trunc(explicit)
  const legacyIndex = cell ? numberField(cell, 'index') : undefined
  return legacyIndex !== undefined && legacyIndex >= 0 ? Math.trunc(legacyIndex) + 1 : undefined
}

/**
 * Notebook tool results can include full notebook/cell/output objects. Chat history
 * only needs a small operation receipt, so this intentionally projects details down
 * to path, one-based cell number, cell id/type, execution state/count, and the
 * human summary string.
 */
export function extractNotebookToolSummary(result: unknown): NotebookToolSummary | undefined {
  const details = detailsFromToolResult(result)
  if (!details || typeof details !== 'object') return undefined
  const record = details as Record<string, unknown>
  const kind = stringField(record, 'kind')
  if (!kind || !kind.startsWith('notebook_')) return undefined

  const cell =
    record.cell && typeof record.cell === 'object' ? (record.cell as Record<string, unknown>) : null
  const execution =
    record.execution && typeof record.execution === 'object'
      ? (record.execution as Record<string, unknown>)
      : null
  const cellNumber = notebookCellNumberFrom(record, cell)
  const cellId = stringField(record, 'cellId') ?? (cell ? stringField(cell, 'id') : undefined)
  const cellType =
    stringField(record, 'cellType') ??
    (cell ? (stringField(cell, 'cellType') ?? stringField(cell, 'cell_type')) : undefined)
  const executionState =
    stringField(record, 'executionState') ??
    (execution ? stringField(execution, 'state') : undefined)
  const executionCount =
    numberOrNullField(record, 'executionCount') ??
    (execution ? numberOrNullField(execution, 'executionCount') : undefined)

  return {
    kind,
    ...(stringField(record, 'path') ? { path: stringField(record, 'path') } : {}),
    ...(stringField(record, 'relativePath')
      ? { relativePath: stringField(record, 'relativePath') }
      : {}),
    ...(cellNumber !== undefined ? { cellNumber } : {}),
    ...(cellId ? { cellId } : {}),
    ...(cellType ? { cellType } : {}),
    ...(executionState ? { executionState } : {}),
    ...(executionCount !== undefined ? { executionCount } : {}),
    ...(stringField(record, 'summary') ? { summary: stringField(record, 'summary') } : {})
  }
}

function toolOutputArtifactFrom(value: unknown):
  | {
      kind: 'tool_output'
      path: string
      bytes: number
    }
  | undefined {
  if (!value || typeof value !== 'object') return undefined
  const artifact = value as { kind?: unknown; path?: unknown; bytes?: unknown }
  if (
    artifact.kind !== 'tool_output' ||
    typeof artifact.path !== 'string' ||
    typeof artifact.bytes !== 'number'
  ) {
    return undefined
  }
  return { kind: 'tool_output', path: artifact.path, bytes: artifact.bytes }
}

export function toolArgsPreview(args: unknown): string {
  if (!args || typeof args !== 'object') {
    return ''
  }
  const record = args as Record<string, unknown>
  const preferred = ['command', 'path', 'file_path', 'pattern', 'code', 'query']
  for (const key of preferred) {
    if (typeof record[key] === 'string' && record[key]) {
      return record[key] as string
    }
  }
  const firstString = Object.values(record).find(
    (item): item is string => typeof item === 'string' && item.length > 0
  )
  return firstString ?? ''
}

function textFromToolContentParts(content: unknown[]): string {
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return ''
      }
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

export function extractToolText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return textFromToolContentParts(value)
  }
  if (value && typeof value === 'object') {
    const record = value as { content?: unknown; output?: unknown; text?: unknown }
    if (Array.isArray(record.content)) {
      const text = textFromToolContentParts(record.content)
      if (text) {
        return text
      }
      if (typeof record.output !== 'string' && typeof record.text !== 'string') {
        return ''
      }
    }
    if (typeof record.output === 'string') {
      return record.output
    }
    if (typeof record.text === 'string') {
      return record.text
    }
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return value == null ? '' : String(value)
}

function textFromContentParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        return (part as { text?: string }).text ?? ''
      }
      return ''
    })
    .join('')
}

function durationBetween(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) return undefined
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, end - start)
}

function createdAtField(createdAt?: string): { createdAt: string } | Record<string, never> {
  return typeof createdAt === 'string' ? { createdAt } : {}
}

function completedAtField(completedAt?: string): { completedAt: string } | Record<string, never> {
  return typeof completedAt === 'string' ? { completedAt } : {}
}

function normalizedVisibleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function runIdField(runId?: unknown): { runId: string } | Record<string, never> {
  return typeof runId === 'string' && runId ? { runId } : {}
}

export function hasEquivalentErrorMessage(
  items: ChatItem[],
  content: string,
  options: { runId?: string; exceptId?: string } = {}
): boolean {
  const normalized = normalizedVisibleText(content)
  if (!normalized || !options.runId) return false

  return items.some(
    (item) =>
      item.id !== options.exceptId &&
      item.role === 'error' &&
      item.runId === options.runId &&
      normalizedVisibleText(item.content) === normalized
  )
}

export function isDisplayableAssistantText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed !== '.'
}

export function chatItemFromPhiTimelineEvent(event: {
  type?: string
  eventId?: string
  runId?: string
  approvalId?: string
  toolName?: unknown
  summary?: unknown
  shortSummary?: unknown
  reason?: unknown
  action?: unknown
  errorMessage?: unknown
  createdAt?: string
  fromProviderId?: unknown
  fromModelId?: unknown
  toProviderId?: unknown
  toModelId?: unknown
  toModelName?: unknown
}): ChatItem | null {
  const id = event.eventId ?? `${event.type ?? 'phi'}-${event.runId ?? event.approvalId ?? 'event'}`
  if (event.type === 'run_interrupted') {
    return {
      id,
      role: 'warning',
      content: event.reason === 'app_restarted' ? '上次运行因应用重启而中断。' : '运行已中断。',
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'run_failed') {
    const error = typeof event.errorMessage === 'string' ? event.errorMessage.trim() : ''
    return {
      id,
      role: 'error',
      content: error || '运行失败。',
      ...runIdField(event.runId),
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'approval_requested') {
    const toolName = typeof event.toolName === 'string' ? event.toolName : '工具调用'
    const summary = typeof event.summary === 'string' && event.summary ? `：${event.summary}` : ''
    return {
      id,
      role: 'warning',
      content: `等待批准 ${toolName}${summary}`,
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'approval_denied') {
    return { id, role: 'error', content: '权限请求已拒绝。', ...createdAtField(event.createdAt) }
  }
  if (event.type === 'approval_cancelled') {
    return {
      id,
      role: 'warning',
      content: '权限请求已取消。',
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'context_compacted') {
    const rawSummary =
      typeof event.shortSummary === 'string'
        ? event.shortSummary
        : typeof event.summary === 'string'
          ? event.summary
          : ''
    const summary =
      rawSummary.length > 0
        ? `\n\n摘要：${rawSummary.length > 600 ? `${rawSummary.slice(0, 600)}...` : rawSummary}`
        : ''
    return {
      id,
      role: 'warning',
      content: `上下文已压缩，较早内容已汇总给模型；聊天时间线会继续保留可见历史。${summary}`,
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'context_compaction_failed') {
    const error = typeof event.errorMessage === 'string' ? `：${event.errorMessage}` : ''
    return {
      id,
      role: 'error',
      content: `上下文压缩失败${error}`,
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'model_selection_migrated') {
    const from =
      typeof event.fromProviderId === 'string' && typeof event.fromModelId === 'string'
        ? `${event.fromProviderId}/${event.fromModelId}`
        : '旧模型'
    const to =
      typeof event.toProviderId === 'string' && typeof event.toModelId === 'string'
        ? `${event.toProviderId}/${event.toModelId}`
        : typeof event.toModelName === 'string'
          ? event.toModelName
          : '可用模型'
    return {
      id,
      role: 'warning',
      content: `${from} 当前不可用，已切换到 ${to}。`,
      ...createdAtField(event.createdAt)
    }
  }
  return null
}

export function runLifecycleItemFromPhiTimelineEvent(event: {
  type?: string
  eventId?: string
  runId?: string
  createdAt?: string
  durationMs?: unknown
}): RunLifecycleItem | null {
  if (typeof event.createdAt !== 'string') return null

  const lifecycleEvent =
    event.type === 'run_started'
      ? 'started'
      : event.type === 'run_completed'
        ? 'completed'
        : event.type === 'run_failed'
          ? 'failed'
          : event.type === 'run_interrupted'
            ? 'interrupted'
            : null
  if (!lifecycleEvent) return null

  return {
    id: `run-${event.eventId ?? `${event.type}-${event.runId ?? event.createdAt}`}`,
    role: 'run',
    event: lifecycleEvent,
    ...(typeof event.runId === 'string' ? { runId: event.runId } : {}),
    createdAt: event.createdAt,
    ...(typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)
      ? { durationMs: Math.max(0, event.durationMs) }
      : {})
  }
}

/**
 * Turns the raw AgentMessage[] a saved session resumes with into the same ChatItem[]
 * shape the live streaming reducer in App.tsx builds incrementally, so resuming an
 * old conversation renders identically to one that just finished streaming.
 */
export function chatItemsFromSessionMessages(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = []
  const toolCallIndexById = new Map<string, number>()
  const duplicateTextCounts = new Map<string, number>()
  const phiToolCallIds = new Set<string>()
  let hasPreferredPhiTimeline = false

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as {
      source?: string
      type?: string
      content?: unknown
      toolCallId?: string
      preferPhiTimeline?: boolean
    }
    if (message.source !== 'phi') continue
    if (message.preferPhiTimeline === true) {
      hasPreferredPhiTimeline = true
    }

    if (
      (message.type === 'user_message' || message.type === 'assistant_message_finalized') &&
      typeof message.content === 'string'
    ) {
      duplicateTextCounts.set(message.content, (duplicateTextCounts.get(message.content) ?? 0) + 1)
    }
    if (
      (message.type === 'tool_call_started' || message.type === 'tool_call_completed') &&
      typeof message.toolCallId === 'string'
    ) {
      phiToolCallIds.add(message.toolCallId)
    }
  }

  const isRuntimeMessageCoveredByPhi = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object') return false
    const message = raw as { source?: string; role?: string; content?: unknown }
    if (message.source === 'phi') return false
    if (message.role === 'user') {
      const text = textFromContentParts(message.content)
      return text.length > 0 && duplicateTextCounts.has(text)
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return false
    return message.content.some((part) => {
      if (!part || typeof part !== 'object' || (part as { type?: string }).type !== 'text') {
        return false
      }
      const text = (part as { text?: string }).text ?? ''
      return text.length > 0 && duplicateTextCounts.has(text)
    })
  }

  const runtimeCoveredFromIndex = hasPreferredPhiTimeline
    ? messages.findIndex(isRuntimeMessageCoveredByPhi)
    : -1

  const consumeDuplicateText = (text: string): boolean => {
    const count = duplicateTextCounts.get(text) ?? 0
    if (count <= 0) return false
    if (count === 1) {
      duplicateTextCounts.delete(text)
    } else {
      duplicateTextCounts.set(text, count - 1)
    }
    return true
  }

  for (const [messageIndex, raw] of messages.entries()) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as {
      source?: string
      role?: string
      type?: string
      eventId?: string
      runId?: string
      preferPhiTimeline?: boolean
      content?: unknown
      toolCallId?: string
      toolName?: string
      args?: unknown
      output?: string
      outputPath?: string
      outputBytes?: number
      outputTruncated?: boolean
      outputArtifact?: unknown
      details?: unknown
      isError?: boolean
      durationMs?: number
      createdAt?: string
      fromProviderId?: string
      fromModelId?: string
      toProviderId?: string
      toModelId?: string
      toModelName?: string
    }

    if (
      runtimeCoveredFromIndex >= 0 &&
      messageIndex >= runtimeCoveredFromIndex &&
      message.source !== 'phi'
    ) {
      continue
    }

    if (message.source === 'phi') {
      const lifecycleItem = runLifecycleItemFromPhiTimelineEvent(message)
      if (lifecycleItem) {
        items.push(lifecycleItem)
      }

      if (message.type === 'tool_call_started' && typeof message.toolCallId === 'string') {
        let argsJson = ''
        try {
          argsJson = JSON.stringify(message.args, null, 2) ?? ''
        } catch {
          argsJson = ''
        }
        toolCallIndexById.set(message.toolCallId, items.length)
        items.push({
          id: message.toolCallId,
          role: 'tool',
          toolName: typeof message.toolName === 'string' ? message.toolName : 'tool',
          argsPreview: toolArgsPreview(message.args),
          argsJson,
          output: '',
          status: 'running',
          ...createdAtField(message.createdAt)
        })
        continue
      }

      if (message.type === 'tool_call_completed' && typeof message.toolCallId === 'string') {
        const index = toolCallIndexById.get(message.toolCallId)
        if (index !== undefined) {
          const current = items[index]
          if (current.role === 'tool') {
            const outputArtifact = toolOutputArtifactFrom(message.outputArtifact)
            const durationMs = durationBetween(current.createdAt, message.createdAt)
            items[index] = {
              ...current,
              output: message.output ?? current.output,
              outputPath: message.outputPath ?? outputArtifact?.path,
              outputBytes: message.outputBytes ?? outputArtifact?.bytes,
              outputTruncated: message.outputTruncated,
              outputArtifact,
              ...(isNotebookToolName(current.toolName)
                ? {
                    notebook:
                      extractNotebookToolSummary({ details: message.details }) ?? current.notebook
                  }
                : {}),
              status: message.isError ? 'error' : 'done',
              ...completedAtField(message.createdAt),
              ...(durationMs !== undefined ? { durationMs } : {})
            }
          }
        }
        continue
      }

      if (message.type === 'user_message' && typeof message.content === 'string') {
        items.push({
          id: message.eventId ?? `user-${items.length}`,
          role: 'user',
          content: message.content,
          ...createdAtField(message.createdAt)
        })
        continue
      }

      if (message.type === 'assistant_message_finalized' && typeof message.content === 'string') {
        if (!isDisplayableAssistantText(message.content)) continue
        items.push({
          id: message.eventId ?? `assistant-${items.length}`,
          role: 'assistant',
          content: message.content,
          ...createdAtField(message.createdAt)
        })
        continue
      }

      if (message.type === 'assistant_thinking_completed' && typeof message.content === 'string') {
        items.push({
          id: message.eventId ?? `thinking-${items.length}`,
          role: 'thinking',
          content: message.content,
          ...completedAtField(message.createdAt),
          ...(typeof message.durationMs === 'number' ? { durationMs: message.durationMs } : {})
        })
        continue
      }

      const item = chatItemFromPhiTimelineEvent(message)
      if (
        item &&
        !(
          item.role === 'error' &&
          hasEquivalentErrorMessage(items, item.content, { runId: item.runId })
        )
      ) {
        items.push(item)
      }
      continue
    }

    if (message.role === 'user') {
      const text = textFromContentParts(message.content)
      if (consumeDuplicateText(text)) continue
      if (text) {
        items.push({ id: `user-${items.length}`, role: 'user', content: text })
      }
      continue
    }

    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object') continue
        const type = (part as { type?: string }).type

        if (type === 'text') {
          const text = (part as { text?: string }).text ?? ''
          if (consumeDuplicateText(text)) continue
          if (isDisplayableAssistantText(text))
            items.push({ id: `assistant-${items.length}`, role: 'assistant', content: text })
        } else if (type === 'thinking') {
          const text = (part as { thinking?: string }).thinking ?? ''
          if (text) items.push({ id: `thinking-${items.length}`, role: 'thinking', content: text })
        } else if (type === 'toolCall') {
          const id = (part as { id?: string }).id ?? `tool-${items.length}`
          if (phiToolCallIds.has(id)) continue
          const name = (part as { name?: string }).name ?? 'tool'
          const args = (part as { arguments?: unknown }).arguments
          let argsJson = ''
          try {
            argsJson = JSON.stringify(args, null, 2) ?? ''
          } catch {
            argsJson = ''
          }
          toolCallIndexById.set(id, items.length)
          items.push({
            id,
            role: 'tool',
            toolName: name,
            argsPreview: toolArgsPreview(args),
            argsJson,
            output: '',
            status: 'done'
          })
        }
      }
      continue
    }

    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      if (phiToolCallIds.has(message.toolCallId)) continue
      const index = toolCallIndexById.get(message.toolCallId)
      if (index !== undefined) {
        const current = items[index]
        if (current.role === 'tool') {
          items[index] = {
            ...current,
            output: extractToolText(message.content) || current.output,
            ...(isNotebookToolName(current.toolName)
              ? {
                  notebook: extractNotebookToolSummary(message.content) ?? current.notebook
                }
              : {}),
            status: message.isError ? 'error' : 'done'
          }
        }
      }
    }
  }

  return items
}
