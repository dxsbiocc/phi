import type { ChatItem } from '../../../types'

type ToolItem = Extract<ChatItem, { role: 'tool' }>
type RuntimeTextHelpers = {
  textFromContentParts: (parts: unknown[]) => string
  toolArgsPreview: (args: unknown) => string
  extractToolText: (content: unknown) => string
}
type TimedTool = { afterThinking: number; item: ToolItem }
type TimedRecovery = { pending: TimedTool[]; renderedThinking: number }
export type RuntimeToolRecovery = {
  byAnswer: Map<string, ToolItem[]>
  byMessage: Map<string, TimedRecovery>
}

function messageKey(runId: unknown, createdAt: unknown): string | null {
  return typeof runId === 'string' && typeof createdAt === 'string'
    ? `${runId}\u0000${createdAt}`
    : null
}

/** Restore provider-managed calls that older Phi timelines never recorded. */
export function recoverMissingRuntimeTools(
  messages: unknown[],
  coveredFromIndex: number,
  phiToolCallIds: Set<string>,
  helpers: RuntimeTextHelpers
): RuntimeToolRecovery {
  const recovery: RuntimeToolRecovery = { byAnswer: new Map(), byMessage: new Map() }
  if (coveredFromIndex < 0) return recovery

  const runtimeMessages = messages.slice(coveredFromIndex)
  const resultByCallId = new Map<string, { content?: unknown; isError?: boolean }>()
  const messageKeysByAnswer = new Map<string, string[]>()
  for (const raw of runtimeMessages) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as {
      source?: string
      role?: string
      type?: string
      toolCallId?: string
      content?: unknown
      isError?: boolean
      runId?: string
      createdAt?: string
    }
    if (message.source !== 'phi' && message.role === 'toolResult' && message.toolCallId) {
      resultByCallId.set(message.toolCallId, message)
    }
    if (
      message.source === 'phi' &&
      message.type === 'assistant_message_finalized' &&
      typeof message.content === 'string'
    ) {
      const key = messageKey(message.runId, message.createdAt)
      if (key)
        messageKeysByAnswer.set(message.content, [
          ...(messageKeysByAnswer.get(message.content) ?? []),
          key
        ])
    }
  }

  for (const raw of runtimeMessages) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as { source?: string; role?: string; content?: unknown }
    if (
      message.source === 'phi' ||
      message.role !== 'assistant' ||
      !Array.isArray(message.content)
    ) {
      continue
    }
    const answer = helpers.textFromContentParts(message.content)
    if (!answer) continue
    let thinkingCount = 0
    const missing: TimedTool[] = []
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const call = part as { type?: string; id?: string; name?: string; arguments?: unknown }
      if (call.type === 'thinking') {
        thinkingCount += 1
        continue
      }
      if (call.type !== 'toolCall' || !call.id || phiToolCallIds.has(call.id)) continue
      const result = resultByCallId.get(call.id)
      let argsJson = ''
      try {
        argsJson = JSON.stringify(call.arguments, null, 2) ?? ''
      } catch {
        argsJson = ''
      }
      missing.push({
        afterThinking: thinkingCount,
        item: {
          id: call.id,
          role: 'tool',
          toolName: call.name ?? 'tool',
          argsPreview: helpers.toolArgsPreview(call.arguments),
          argsJson,
          output: result ? helpers.extractToolText(result.content) : '',
          status: result?.isError ? 'error' : 'done'
        }
      })
    }
    if (missing.length === 0) continue
    const key = messageKeysByAnswer.get(answer)?.shift()
    if (key) recovery.byMessage.set(key, { pending: missing, renderedThinking: 0 })
    else
      recovery.byAnswer.set(answer, [
        ...(recovery.byAnswer.get(answer) ?? []),
        ...missing.map((tool) => tool.item)
      ])
  }
  return recovery
}

export function appendRecoveredRuntimeToolsBeforeThinking(
  items: ChatItem[],
  recovery: RuntimeToolRecovery,
  runId: unknown,
  createdAt: unknown
): void {
  const key = messageKey(runId, createdAt)
  const group = key ? recovery.byMessage.get(key) : undefined
  if (!group || group.renderedThinking !== 0) return
  items.push(...group.pending.filter((tool) => tool.afterThinking === 0).map((tool) => tool.item))
  group.pending = group.pending.filter((tool) => tool.afterThinking !== 0)
}

export function appendRecoveredRuntimeToolsAfterThinking(
  items: ChatItem[],
  recovery: RuntimeToolRecovery,
  runId: unknown,
  createdAt: unknown
): void {
  const key = messageKey(runId, createdAt)
  const group = key ? recovery.byMessage.get(key) : undefined
  if (!group) return
  group.renderedThinking += 1
  items.push(
    ...group.pending
      .filter((tool) => tool.afterThinking === group.renderedThinking)
      .map((tool) => tool.item)
  )
  group.pending = group.pending.filter((tool) => tool.afterThinking !== group.renderedThinking)
}

export function appendRecoveredRuntimeToolsBeforeAnswer(
  items: ChatItem[],
  recovery: RuntimeToolRecovery,
  answer: string,
  runId: unknown,
  createdAt: unknown
): void {
  const key = messageKey(runId, createdAt)
  const group = key ? recovery.byMessage.get(key) : undefined
  if (group) {
    items.push(...group.pending.map((tool) => tool.item))
    recovery.byMessage.delete(key as string)
  } else {
    items.push(...(recovery.byAnswer.get(answer) ?? []))
    recovery.byAnswer.delete(answer)
  }
}
