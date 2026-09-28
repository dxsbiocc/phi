import type {
  AgentExecutionItem,
  ChatItem,
  ChatMessage,
  RunLifecycleItem,
  ToolCallItem,
  PresentedFilesItem,
  PlanReviewItem,
  WorkspaceChangeSummaryItem,
  WrapperPlanItem
} from '../types'

export type VisibleChatItem =
  | ChatMessage
  | ToolCallItem
  | WrapperPlanItem
  | AgentExecutionItem
  | WorkspaceChangeSummaryItem
  | PresentedFilesItem
  | PlanReviewItem

export type ProcessingItem =
  | ToolCallItem
  | AgentExecutionItem
  | (ChatMessage & { role: 'assistant' | 'error' | 'warning' | 'thinking' })

export type RenderGroup =
  | { kind: 'tool-group'; key: string; items: ToolCallItem[] }
  | {
      kind: 'processing-group'
      key: string
      items: ProcessingItem[]
      startedAtMs?: number
      completedAtMs?: number
      durationMs?: number
    }
  | { kind: 'single'; key: string; item: VisibleChatItem }

function isRunLifecycleItem(message: ChatItem): message is RunLifecycleItem {
  return message.role === 'run'
}

function isVisibleChatItem(message: ChatItem): message is VisibleChatItem {
  return !isRunLifecycleItem(message)
}

function groupConsecutiveTools(messages: ChatItem[]): RenderGroup[] {
  const groups: RenderGroup[] = []
  let run: ToolCallItem[] = []

  const flushRun = (): void => {
    if (run.length === 0) return
    if (run.length === 1) {
      groups.push({ kind: 'single', key: run[0].id, item: run[0] })
    } else {
      groups.push({ kind: 'tool-group', key: run[0].id, items: run })
    }
    run = []
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      run.push(message)
    } else if (isVisibleChatItem(message)) {
      flushRun()
      groups.push({ kind: 'single', key: message.id, item: message })
    }
  }
  flushRun()

  return groups
}

function isProcessingItem(message: ChatItem): message is ProcessingItem {
  // wrapper_plan is a persistent artifact like the final answer, not
  // transient tool noise to collapse — never sweep it into a processing
  // group. See docs/design/phi-wrapper-technical-design.md, "Chat And UI
  // Integration".
  return (
    message.role !== 'user' &&
    message.role !== 'run' &&
    message.role !== 'wrapper_plan' &&
    message.role !== 'workspace_changes' &&
    message.role !== 'presented_files' &&
    message.role !== 'plan_review'
  )
}

function isProcessingArtifact(message: ChatItem): boolean {
  return (
    message.role === 'tool' || message.role === 'thinking' || message.role === 'agent_execution'
  )
}

export function timestampMs(value?: string): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function itemStartedAtMs(item: ChatItem): number | null {
  if (isRunLifecycleItem(item)) return timestampMs(item.createdAt)

  const createdAt = timestampMs(item.createdAt)
  const completedAt = timestampMs('completedAt' in item ? item.completedAt : undefined)
  const durationStart =
    completedAt !== null && 'durationMs' in item && typeof item.durationMs === 'number'
      ? Math.max(0, completedAt - item.durationMs)
      : null

  if (createdAt !== null && durationStart !== null) return Math.min(createdAt, durationStart)
  if (createdAt !== null) return createdAt
  return durationStart
}

function firstRunStartedAtMs(items: ChatItem[]): number | undefined {
  const timestamps = items
    .filter(
      (item): item is RunLifecycleItem => isRunLifecycleItem(item) && item.event === 'started'
    )
    .map((item) => timestampMs(item.createdAt))
    .filter((value): value is number => value !== null)
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined
}

function lastRunTerminalAtMs(items: ChatItem[]): number | undefined {
  const timestamps = items
    .filter(
      (item): item is RunLifecycleItem => isRunLifecycleItem(item) && item.event !== 'started'
    )
    .map((item) => timestampMs(item.createdAt))
    .filter((value): value is number => value !== null)
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined
}

function lastRunTerminalDurationMs(items: ChatItem[]): number | undefined {
  const durations = items
    .filter(
      (item): item is RunLifecycleItem => isRunLifecycleItem(item) && item.event !== 'started'
    )
    .map((item) => item.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return durations.length > 0 ? durations[durations.length - 1] : undefined
}

function itemCompletedAtMs(item: ChatItem): number | null {
  if (isRunLifecycleItem(item)) return timestampMs(item.createdAt)

  return (
    timestampMs('completedAt' in item ? item.completedAt : undefined) ?? timestampMs(item.createdAt)
  )
}

function minTimestamp(items: ChatItem[]): number | undefined {
  const timestamps = items
    .map(itemStartedAtMs)
    .filter((value): value is number => typeof value === 'number')
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined
}

function maxTimestamp(items: ChatItem[]): number | undefined {
  const timestamps = items
    .map(itemCompletedAtMs)
    .filter((value): value is number => typeof value === 'number')
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined
}

function processingGroupKey(turnItems: ChatItem[], processingItems: ProcessingItem[]): string {
  const lifecycle = turnItems.find(isRunLifecycleItem)
  return `processing-${lifecycle?.runId ?? lifecycle?.id ?? processingItems[0]?.id ?? turnItems[0].id}`
}

export function groupMessages(
  messages: ChatItem[],
  options: { activeRun?: boolean } = {}
): RenderGroup[] {
  const groups: RenderGroup[] = []
  let turnItems: ChatItem[] = []

  const flushTurn = (activeTurn = false): void => {
    if (turnItems.length === 0) return

    const runStartedAtMs = firstRunStartedAtMs(turnItems)
    const runCompletedAtMs = lastRunTerminalAtMs(turnItems)
    const runDurationMs = lastRunTerminalDurationMs(turnItems)
    const lastProcessingIndex = turnItems.findLastIndex(isProcessingArtifact)
    if (lastProcessingIndex < 0) {
      if (runStartedAtMs !== undefined) {
        const visibleItems = turnItems.filter(isVisibleChatItem)
        if (visibleItems.length > 0 || groups.length > 0) {
          groups.push({
            kind: 'processing-group',
            key: processingGroupKey(turnItems, []),
            items: [],
            startedAtMs: runStartedAtMs,
            completedAtMs: runCompletedAtMs ?? maxTimestamp(visibleItems),
            durationMs: runDurationMs
          })
        }
      }
      groups.push(
        ...turnItems
          .filter(isVisibleChatItem)
          .map((item) => ({ kind: 'single' as const, key: item.id, item }))
      )
      turnItems = []
      return
    }

    const keepStreamingTextInProcessing = activeTurn && runCompletedAtMs === undefined
    const processingItems = keepStreamingTextInProcessing
      ? turnItems.filter(isProcessingItem)
      : turnItems.slice(0, lastProcessingIndex + 1).filter(isProcessingItem)
    const trailingItems = keepStreamingTextInProcessing
      ? turnItems.filter(
          (item): item is VisibleChatItem => isVisibleChatItem(item) && !isProcessingItem(item)
        )
      : turnItems.slice(lastProcessingIndex + 1).filter(isVisibleChatItem)
    if (processingItems.length > 0 || runStartedAtMs !== undefined) {
      groups.push({
        kind: 'processing-group',
        key: processingGroupKey(turnItems, processingItems),
        items: processingItems,
        startedAtMs: runStartedAtMs ?? minTimestamp(processingItems),
        completedAtMs: runCompletedAtMs ?? maxTimestamp([...processingItems, ...trailingItems]),
        durationMs: runDurationMs
      })
    }

    groups.push(...trailingItems.map((item) => ({ kind: 'single' as const, key: item.id, item })))
    turnItems = []
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flushTurn()
      groups.push({ kind: 'single', key: message.id, item: message })
      continue
    }

    turnItems.push(message)
  }

  flushTurn(Boolean(options.activeRun))
  return groups
}

export function groupProcessingItems(items: ProcessingItem[]): RenderGroup[] {
  return groupConsecutiveTools(items)
}

export function processingGroupStatus(
  items: ProcessingItem[],
  isActive: boolean
): ToolCallItem['status'] | null {
  const tools = items.filter((item): item is ToolCallItem => item.role === 'tool')
  const agentExecutions = items.filter(
    (item): item is AgentExecutionItem => item.role === 'agent_execution'
  )
  if (
    isActive ||
    tools.some((item) => item.status === 'running') ||
    agentExecutions.some((item) => item.status === 'running')
  ) {
    return 'running'
  }
  return null
}

function formatProcessingDuration(durationMs: number): string {
  const totalSeconds =
    durationMs > 0 && durationMs < 1000 ? 1 : Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours} 小时 ${minutes} 分钟 ${seconds} 秒`
  if (minutes > 0) return `${minutes} 分钟 ${seconds} 秒`
  return `${seconds} 秒`
}

function fallbackDurationMs(items: ProcessingItem[]): number | null {
  const durations = items
    .map((item) => item.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) : null
}

function processingElapsedMs({
  items,
  isActive,
  nowMs,
  fallbackStartedAtMs,
  startedAtMs,
  completedAtMs,
  durationMs
}: {
  items: ProcessingItem[]
  isActive: boolean
  nowMs: number
  fallbackStartedAtMs: number
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
}): number {
  if (!isActive && typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    return Math.max(0, durationMs)
  }

  const start = startedAtMs ?? minTimestamp(items) ?? (isActive ? fallbackStartedAtMs : undefined)
  const end = isActive ? nowMs : (completedAtMs ?? maxTimestamp(items))

  if (start !== undefined && end !== undefined) {
    return Math.max(0, end - start)
  }

  return fallbackDurationMs(items) ?? 0
}

export function processingStatusText({
  items,
  isActive,
  nowMs,
  fallbackStartedAtMs,
  startedAtMs,
  completedAtMs,
  durationMs
}: {
  items: ProcessingItem[]
  isActive: boolean
  nowMs: number
  fallbackStartedAtMs: number
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
}): string {
  const elapsed = formatProcessingDuration(
    processingElapsedMs({
      items,
      isActive,
      nowMs,
      fallbackStartedAtMs,
      startedAtMs,
      completedAtMs,
      durationMs
    })
  )

  return isActive ? `正在处理，已耗时 ${elapsed}` : `已完成，总共用时 ${elapsed}`
}
