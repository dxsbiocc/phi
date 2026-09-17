import type { AgentEventSummary, ChatItem } from '../types'
import {
  chatItemFromPhiTimelineEvent,
  extractNotebookToolSummary,
  extractToolText,
  extractWrapperPlanId,
  hasEquivalentErrorMessage,
  isDisplayableAssistantText,
  isNotebookToolName,
  isWrapperToolName,
  runLifecycleItemFromPhiTimelineEvent,
  toolArgsPreview
} from './chatItems'
import { outputPreviewText } from './toolOutputPresentation'

export interface AgentEventReducerState {
  messages: ChatItem[]
  textBlockIds: Map<number, string>
  thinkingBlockIds: Map<number, string>
  thinkingStartedAtMs: Map<number, number>
  nextId: number
}

function extractTextFromMessage(message: AgentEventSummary['message']): string {
  if (!message || !Array.isArray(message.content)) {
    return ''
  }

  return message.content
    .map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return part.text
      }
      return ''
    })
    .join('')
}

function createBlockId(prefix: string, contentIndex: number, nextId: number): string {
  return `${prefix}-${nextId}-${contentIndex}`
}

function eventTimestampMs(event: AgentEventSummary): number {
  if (typeof event.createdAt === 'string') {
    const timestamp = Date.parse(event.createdAt)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return Date.now()
}

function durationBetween(startedAt?: string, event?: AgentEventSummary): number | undefined {
  if (!startedAt || !event?.createdAt) return undefined
  const start = Date.parse(startedAt)
  const end = eventTimestampMs(event)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, end - start)
}

function createdAtField(createdAt?: string): { createdAt: string } | Record<string, never> {
  return typeof createdAt === 'string' ? { createdAt } : {}
}

function completedAtField(completedAt?: string): { completedAt: string } | Record<string, never> {
  return typeof completedAt === 'string' ? { completedAt } : {}
}

function runIdField(runId?: unknown): { runId: string } | Record<string, never> {
  return typeof runId === 'string' && runId ? { runId } : {}
}

function terminalToolStatusForRunEvent(eventType: string): 'done' | 'error' | null {
  if (eventType === 'run_completed') return 'done'
  if (eventType === 'run_failed' || eventType === 'run_interrupted') return 'error'
  return null
}

function shouldFinalizeItemForRun(
  item: ChatItem,
  runId: string | undefined
): item is Extract<ChatItem, { role: 'tool' | 'wrapper_plan' }> {
  if ((item.role !== 'tool' && item.role !== 'wrapper_plan') || item.status !== 'running') {
    return false
  }
  return !runId || !item.runId || item.runId === runId
}

function finalizeRunningItemsForRun(next: ChatItem[], event: AgentEventSummary): void {
  const status = terminalToolStatusForRunEvent(event.type)
  if (!status) return

  for (let index = next.length - 1; index >= 0; index -= 1) {
    const item = next[index]
    if (!shouldFinalizeItemForRun(item, event.runId)) continue
    const durationMs = durationBetween(item.createdAt, event)
    next[index] = {
      ...item,
      status,
      ...completedAtField(event.createdAt),
      ...(durationMs !== undefined ? { durationMs } : {})
    }
  }
}

function toolOutputMetadataFrom(
  result: unknown
): Pick<
  Extract<ChatItem, { role: 'tool' }>,
  'outputPath' | 'outputBytes' | 'outputTruncated' | 'outputArtifact'
> {
  if (!result || typeof result !== 'object') return {}
  const record = result as {
    outputPath?: unknown
    outputBytes?: unknown
    truncated?: unknown
    outputArtifact?: unknown
  }
  const artifact =
    record.outputArtifact && typeof record.outputArtifact === 'object'
      ? (record.outputArtifact as { kind?: unknown; path?: unknown; bytes?: unknown })
      : null
  const outputArtifact =
    artifact?.kind === 'tool_output' &&
    typeof artifact.path === 'string' &&
    typeof artifact.bytes === 'number'
      ? { kind: 'tool_output' as const, path: artifact.path, bytes: artifact.bytes }
      : undefined
  return {
    outputPath: typeof record.outputPath === 'string' ? record.outputPath : outputArtifact?.path,
    outputBytes:
      typeof record.outputBytes === 'number' ? record.outputBytes : outputArtifact?.bytes,
    outputTruncated: record.truncated === true ? true : undefined,
    outputArtifact
  }
}

export function createAgentEventReducerState(
  messages: ChatItem[] = [],
  nextId = 0
): AgentEventReducerState {
  return {
    messages,
    textBlockIds: new Map(),
    thinkingBlockIds: new Map(),
    thinkingStartedAtMs: new Map(),
    nextId
  }
}

export function replaceAgentEventMessages(
  state: AgentEventReducerState,
  messages: ChatItem[]
): AgentEventReducerState {
  return createAgentEventReducerState(messages, state.nextId)
}

export function updateAgentEventMessages(
  state: AgentEventReducerState,
  updater: (messages: ChatItem[]) => ChatItem[]
): AgentEventReducerState {
  return {
    ...state,
    messages: updater(state.messages)
  }
}

export function reduceAgentEventState(
  state: AgentEventReducerState,
  event: AgentEventSummary
): AgentEventReducerState {
  const next = [...state.messages]
  const textBlockIds = new Map(state.textBlockIds)
  const thinkingBlockIds = new Map(state.thinkingBlockIds)
  const thinkingStartedAtMs = new Map(state.thinkingStartedAtMs)
  let nextId = state.nextId

  if (event.type === 'project_parallel_warning') {
    const count = typeof event.activeCount === 'number' ? event.activeCount : 1
    next.push({
      id: createBlockId('warning', 0, nextId),
      role: 'warning',
      content: `这个项目里还有 ${count} 个会话正在运行或等待权限。当前会话会继续启动，切换会话不会打断后台进程。`,
      ...createdAtField(event.createdAt)
    })
    nextId += 1
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  const lifecycleItem = runLifecycleItemFromPhiTimelineEvent(event)
  if (lifecycleItem) {
    finalizeRunningItemsForRun(next, event)
  }
  if (lifecycleItem && !next.some((item) => item.id === lifecycleItem.id)) {
    next.push(lifecycleItem)
  }

  const timelineItem = chatItemFromPhiTimelineEvent(event)
  if (timelineItem) {
    const isDuplicateError =
      timelineItem.role === 'error' &&
      hasEquivalentErrorMessage(next, timelineItem.content, { runId: timelineItem.runId })
    if (!isDuplicateError && !next.some((item) => item.id === timelineItem.id)) {
      next.push(timelineItem)
    }
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (lifecycleItem) {
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (event.type === 'auto_compaction_end') {
    if (event.skipped) {
      return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
    }
    const content =
      event.aborted || event.errorMessage
        ? `上下文压缩失败：${event.errorMessage ?? '已取消'}`
        : '上下文已压缩，较早内容已汇总给模型；聊天时间线会继续保留可见历史。'
    next.push({
      id: createBlockId(event.aborted || event.errorMessage ? 'error' : 'warning', 0, nextId),
      role: event.aborted || event.errorMessage ? 'error' : 'warning',
      content,
      ...createdAtField(event.createdAt)
    })
    nextId += 1
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
    const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
    if (isWrapperToolName(toolName)) {
      next.push({
        id: event.toolCallId,
        role: 'wrapper_plan',
        ...runIdField(event.runId),
        toolName,
        status: 'running',
        ...createdAtField(event.createdAt)
      })
      return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
    }

    let argsJson = ''
    try {
      argsJson = JSON.stringify(event.args, null, 2) ?? ''
    } catch {
      argsJson = ''
    }
    next.push({
      id: event.toolCallId,
      role: 'tool',
      ...runIdField(event.runId),
      toolName,
      argsPreview: toolArgsPreview(event.args),
      argsJson,
      output: '',
      status: 'running',
      ...createdAtField(event.createdAt)
    })
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (
    (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') &&
    typeof event.toolCallId === 'string'
  ) {
    const index = next.findIndex((item) => item.id === event.toolCallId)
    const current = index >= 0 ? next[index] : null
    if (current && current.role === 'wrapper_plan') {
      if (event.type === 'tool_execution_end') {
        const planId = extractWrapperPlanId(event.result) ?? current.planId
        next[index] = {
          ...current,
          ...(planId !== undefined ? { planId } : {}),
          status: event.isError ? 'error' : 'done',
          ...completedAtField(event.createdAt),
          ...(durationBetween(current.createdAt, event) !== undefined
            ? { durationMs: durationBetween(current.createdAt, event) }
            : {})
        }
      }
      return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
    }
    if (current && current.role === 'tool') {
      if (event.type === 'tool_execution_update') {
        const partial = extractToolText(event.partialResult)
        next[index] = {
          ...current,
          output: partial ? outputPreviewText({ output: partial }) : current.output
        }
      } else {
        const output = extractToolText(event.result)
        const outputMetadata = toolOutputMetadataFrom(event.result)
        const durationMs = durationBetween(current.createdAt, event)
        next[index] = {
          ...current,
          output: output || current.output,
          ...outputMetadata,
          ...(isNotebookToolName(current.toolName)
            ? {
                notebook: extractNotebookToolSummary(event.result) ?? current.notebook
              }
            : {}),
          status: event.isError ? 'error' : 'done',
          ...completedAtField(event.createdAt),
          ...(durationMs !== undefined ? { durationMs } : {})
        }
      }
    }
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (event.type === 'message_start' && event.message?.role === 'assistant') {
    return {
      messages: next,
      textBlockIds: new Map(),
      thinkingBlockIds: new Map(),
      thinkingStartedAtMs: new Map(),
      nextId
    }
  }

  if (event.type === 'message_update' && event.message?.role === 'assistant') {
    const ame = event.assistantMessageEvent
    if (!ame || (ame.type !== 'text_delta' && ame.type !== 'thinking_delta')) {
      return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
    }

    const isThinking = ame.type === 'thinking_delta'
    const blockIds = isThinking ? thinkingBlockIds : textBlockIds
    const contentIndex = ame.contentIndex ?? 0
    let targetId = blockIds.get(contentIndex)
    if (!targetId) {
      targetId = createBlockId(isThinking ? 'thinking' : 'assistant', contentIndex, nextId)
      nextId += 1
      blockIds.set(contentIndex, targetId)
      if (isThinking) {
        thinkingStartedAtMs.set(contentIndex, eventTimestampMs(event))
      }
      next.push(
        isThinking
          ? {
              id: targetId,
              role: 'thinking',
              content: '',
              ...createdAtField(event.createdAt),
              durationMs: 0
            }
          : {
              id: targetId,
              role: 'assistant',
              content: '',
              ...createdAtField(event.createdAt)
            }
      )
    }

    const delta = ame.delta
    if (typeof delta === 'string') {
      const timestamp = eventTimestampMs(event)
      const index = next.findIndex((item) => item.id === targetId)
      const current = index >= 0 ? next[index] : null
      if (current && (current.role === 'assistant' || current.role === 'thinking')) {
        const startedAt = thinkingStartedAtMs.get(contentIndex) ?? timestamp
        next[index] = {
          ...current,
          ...(isThinking ? completedAtField(event.createdAt) : {}),
          content: `${current.content}${delta}`,
          ...(isThinking
            ? {
                durationMs: Math.max(0, timestamp - startedAt)
              }
            : {})
        }
      }
    }

    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const isError = event.message.stopReason === 'error'
    const errorText = isError ? event.message.errorMessage || '请求失败' : ''
    const textIds = [...textBlockIds.values()]

    if (isError) {
      const lastTextId = textIds[textIds.length - 1]
      const index = lastTextId ? next.findIndex((item) => item.id === lastTextId) : -1
      const current = index >= 0 ? next[index] : null
      const content =
        current && current.role === 'assistant' ? current.content || errorText : errorText
      const duplicateExists = content
        ? hasEquivalentErrorMessage(next, content, {
            runId: event.runId,
            exceptId: current?.id
          })
        : false
      if (current && current.role === 'assistant') {
        if (duplicateExists) {
          next.splice(index, 1)
        } else {
          next[index] = {
            ...current,
            role: 'error',
            content,
            ...(typeof event.runId === 'string' ? { runId: event.runId } : {}),
            ...completedAtField(event.createdAt)
          }
        }
      } else if (errorText && !duplicateExists) {
        next.push({
          id: createBlockId('error', 0, nextId),
          role: 'error',
          content: errorText,
          ...(typeof event.runId === 'string' ? { runId: event.runId } : {}),
          ...createdAtField(event.createdAt)
        })
        nextId += 1
      }
    } else if (textIds.length === 0) {
      const finalMessage = extractTextFromMessage(event.message)
      if (isDisplayableAssistantText(finalMessage)) {
        next.push({
          id: createBlockId('assistant', 0, nextId),
          role: 'assistant',
          content: finalMessage,
          ...createdAtField(event.createdAt)
        })
        nextId += 1
      }
    }

    for (let i = next.length - 1; i >= 0; i -= 1) {
      const item = next[i]
      if (item.role === 'thinking') {
        const contentIndex = [...thinkingBlockIds.entries()].find(([, id]) => id === item.id)?.[0]
        const startedAt =
          contentIndex === undefined ? undefined : thinkingStartedAtMs.get(contentIndex)
        if (startedAt !== undefined) {
          next[i] = {
            ...item,
            ...completedAtField(event.createdAt),
            durationMs: Math.max(0, eventTimestampMs(event) - startedAt)
          }
        }
      }
      if (
        (item.role === 'thinking' && !item.content) ||
        (item.role === 'assistant' && !isDisplayableAssistantText(item.content))
      ) {
        next.splice(i, 1)
      }
    }

    return {
      messages: next,
      textBlockIds: new Map(),
      thinkingBlockIds: new Map(),
      thinkingStartedAtMs: new Map(),
      nextId
    }
  }

  return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
}
