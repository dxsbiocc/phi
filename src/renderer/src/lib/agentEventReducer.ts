import type { AgentEventSummary, AgentExecutionItem, AgentExecutionStep, ChatItem } from '../types'
import {
  chatItemFromPhiTimelineEvent,
  extractNotebookToolSummary,
  extractTodoSnapshot,
  extractToolText,
  extractWrapperPlanId,
  hasEquivalentErrorMessage,
  isDisplayableAssistantText,
  isNotebookToolName,
  isTodoToolName,
  isWrapperToolName,
  runLifecycleItemFromPhiTimelineEvent,
  toolArgsPreview
} from './chatItems'
import { workspaceChangesItemFromPhiTimelineEvent } from '../features/chat/lib/workspaceChanges'
import { presentedFilesItemFromPhiTimelineEvent } from '../features/chat/lib/presentedFiles'
import { applyPlanReviewDecision, planReviewItemFromEvent } from '../features/chat/lib/planReview'
import {
  uiBlocksItemFromToolEvent,
  unavailableUiBlocksItemFromToolEvent
} from '../features/chat/lib/uiBlocks'
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
): item is Extract<ChatItem, { role: 'tool' | 'wrapper_plan' | 'agent_execution' }> {
  if (
    (item.role !== 'tool' && item.role !== 'wrapper_plan' && item.role !== 'agent_execution') ||
    item.status !== 'running'
  ) {
    return false
  }
  // A background agent carries on after the chat run that started it; its own end completes it.
  if (item.role === 'agent_execution' && item.background) return false
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAgentToolName(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(toolName)
}

function detailsFromToolResult(value: unknown): unknown {
  if (!isRecord(value)) return undefined
  return value.details
}

function agentResultDetails(value: unknown): Record<string, unknown> | null {
  const details = detailsFromToolResult(value)
  return isRecord(details) && details.kind === 'agent_result' ? details : null
}

function agentStepDetails(value: unknown): Record<string, unknown> | null {
  const details = detailsFromToolResult(value)
  if (!isRecord(details) || details.kind !== 'agent_step' || !isRecord(details.step)) return null
  return details.step
}

function outputArtifactFrom(value: unknown):
  | {
      kind: 'tool_output'
      path: string
      bytes: number
    }
  | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.kind !== 'tool_output' ||
    typeof value.path !== 'string' ||
    typeof value.bytes !== 'number'
  ) {
    return undefined
  }
  return { kind: 'tool_output', path: value.path, bytes: value.bytes }
}

function argsJsonFrom(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return ''
  }
}

function agentTaskFromArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  return typeof args.task === 'string' && args.task.trim() ? args.task.trim() : undefined
}

function agentExecutionItemFromStart(event: AgentEventSummary): AgentExecutionItem | null {
  const toolCallId = event.toolCallId
  const agentName =
    event.agentName ?? (isAgentToolName(event.toolName) ? event.toolName : undefined)
  if (!toolCallId || !agentName) return null
  const task = typeof event.task === 'string' ? event.task : (agentTaskFromArgs(event.args) ?? '')
  const args = event.args ?? (task ? { task } : undefined)
  const argsJson = argsJsonFrom(args)
  return {
    id: toolCallId,
    role: 'agent_execution',
    ...runIdField(event.runId),
    agentName,
    task,
    argsPreview: task || toolArgsPreview(args),
    argsJson,
    status: 'running',
    steps: [],
    ...createdAtField(event.createdAt)
  }
}

type AgentExecutionStepUpdate = Partial<AgentExecutionStep> &
  Pick<AgentExecutionStep, 'id' | 'toolName' | 'status'>

function agentStepUpdateFromEvent(event: AgentEventSummary): AgentExecutionStepUpdate | null {
  const record =
    event.type === 'agent_execution_step'
      ? isRecord(event.step)
        ? event.step
        : null
      : agentStepDetails(event.partialResult)
  if (!record) return null

  const id =
    typeof record.id === 'string' && record.id
      ? record.id
      : event.toolCallId
        ? `${event.toolCallId}:step`
        : ''
  if (!id) return null
  const toolName = typeof record.toolName === 'string' && record.toolName ? record.toolName : 'tool'
  const status =
    record.status === 'done' || record.status === 'error' || record.status === 'running'
      ? record.status
      : 'running'
  const args = record.args
  const argsJson = argsJsonFrom(args)
  const output = typeof record.output === 'string' ? record.output : ''
  const artifact = outputArtifactFrom(record.outputArtifact)
  const createdAt =
    typeof record.createdAt === 'string'
      ? record.createdAt
      : status === 'running'
        ? event.createdAt
        : undefined
  const completedAt =
    typeof record.completedAt === 'string'
      ? record.completedAt
      : status !== 'running'
        ? event.createdAt
        : undefined
  const durationMs =
    typeof record.durationMs === 'number'
      ? record.durationMs
      : createdAt && completedAt
        ? durationBetween(createdAt, { ...event, createdAt: completedAt })
        : undefined

  return {
    id,
    toolName,
    status,
    ...(args !== undefined ? { argsPreview: toolArgsPreview(args), argsJson } : {}),
    ...(output ? { output } : {}),
    ...(typeof record.outputPath === 'string' ? { outputPath: record.outputPath } : {}),
    ...(typeof record.outputBytes === 'number' ? { outputBytes: record.outputBytes } : {}),
    ...(record.outputTruncated === true ? { outputTruncated: true } : {}),
    ...(artifact ? { outputArtifact: artifact } : {}),
    ...(typeof record.error === 'string' && record.error ? { error: record.error } : {}),
    ...createdAtField(createdAt),
    ...completedAtField(completedAt),
    ...(durationMs !== undefined ? { durationMs } : {})
  }
}

function findAgentExecutionIndex(next: ChatItem[], toolCallId: string | undefined): number {
  if (!toolCallId) return -1
  return next.findIndex((item) => item.role === 'agent_execution' && item.id === toolCallId)
}

function ensureAgentExecutionItem(next: ChatItem[], event: AgentEventSummary): number {
  const existingIndex = findAgentExecutionIndex(next, event.toolCallId)
  if (existingIndex >= 0) return existingIndex
  const started = agentExecutionItemFromStart(event)
  if (started) {
    next.push(started)
    return next.length - 1
  }
  const id = event.toolCallId ?? `agent-${event.runId ?? next.length}`
  next.push({
    id,
    role: 'agent_execution',
    ...runIdField(event.runId),
    agentName: event.agentName ?? (isAgentToolName(event.toolName) ? event.toolName : 'Agent'),
    task: '',
    argsPreview: '',
    argsJson: '',
    status: 'running',
    steps: [],
    ...createdAtField(event.createdAt)
  })
  return next.length - 1
}

function mergeAgentStep(
  current: AgentExecutionStep | undefined,
  incoming: AgentExecutionStepUpdate
): AgentExecutionStep {
  const createdAt = incoming.createdAt ?? current?.createdAt
  const completedAt = incoming.completedAt ?? current?.completedAt
  const mergedDurationMs =
    incoming.durationMs ??
    (createdAt && completedAt
      ? durationBetween(createdAt, { type: 'agent_step', createdAt: completedAt })
      : undefined) ??
    current?.durationMs
  return {
    id: incoming.id,
    toolName: incoming.toolName || current?.toolName || 'tool',
    argsPreview: incoming.argsPreview ?? current?.argsPreview ?? '',
    argsJson: incoming.argsJson ?? current?.argsJson ?? '',
    output: incoming.output ?? current?.output ?? '',
    status: incoming.status,
    ...createdAtField(createdAt),
    ...completedAtField(completedAt),
    ...(mergedDurationMs !== undefined ? { durationMs: mergedDurationMs } : {}),
    ...((incoming.outputPath ?? current?.outputPath)
      ? { outputPath: incoming.outputPath ?? current?.outputPath }
      : {}),
    ...((incoming.outputBytes ?? current?.outputBytes)
      ? { outputBytes: incoming.outputBytes ?? current?.outputBytes }
      : {}),
    ...((incoming.outputTruncated ?? current?.outputTruncated)
      ? { outputTruncated: incoming.outputTruncated ?? current?.outputTruncated }
      : {}),
    ...((incoming.outputArtifact ?? current?.outputArtifact)
      ? { outputArtifact: incoming.outputArtifact ?? current?.outputArtifact }
      : {}),
    ...((incoming.error ?? current?.error) ? { error: incoming.error ?? current?.error } : {})
  }
}

function agentRunRefFields(event: AgentEventSummary): {
  agentRunId?: string
  agentSessionId?: string
} {
  return {
    ...(typeof event.agentRunId === 'string' && event.agentRunId
      ? { agentRunId: event.agentRunId }
      : {}),
    ...(typeof event.agentSessionId === 'string' && event.agentSessionId
      ? { agentSessionId: event.agentSessionId }
      : {})
  }
}

function applyAgentExecutionBackground(next: ChatItem[], event: AgentEventSummary): boolean {
  if (event.type !== 'agent_execution_background') return false
  const index = ensureAgentExecutionItem(next, event)
  const current = next[index]
  if (current.role !== 'agent_execution') return true
  next[index] = { ...current, ...agentRunRefFields(event), background: true }
  return true
}

function applyAgentExecutionSteered(next: ChatItem[], event: AgentEventSummary): boolean {
  if (event.type !== 'agent_execution_steered') return false
  const text = typeof event.text === 'string' ? event.text.trim() : ''
  if (!text) return true
  const index = ensureAgentExecutionItem(next, event)
  const current = next[index]
  if (current.role !== 'agent_execution') return true
  next[index] = {
    ...current,
    steers: [...(current.steers ?? []), { text, ...createdAtField(event.createdAt) }]
  }
  return true
}

function applyAgentExecutionStep(next: ChatItem[], event: AgentEventSummary): boolean {
  if (
    event.type !== 'agent_execution_step' &&
    !(event.type === 'tool_execution_update' && agentStepDetails(event.partialResult))
  ) {
    return false
  }
  const incoming = agentStepUpdateFromEvent(event)
  if (!incoming) return false
  const index = ensureAgentExecutionItem(next, event)
  const current = next[index]
  if (current.role !== 'agent_execution') return true
  const stepIndex = current.steps.findIndex((step) => step.id === incoming.id)
  const steps =
    stepIndex >= 0
      ? current.steps.map((step, currentIndex) =>
          currentIndex === stepIndex ? mergeAgentStep(step, incoming) : step
        )
      : [...current.steps, mergeAgentStep(undefined, incoming)]
  next[index] = {
    ...current,
    ...agentRunRefFields(event),
    steps,
    status:
      incoming.status === 'error'
        ? 'running'
        : current.status === 'done' || current.status === 'error'
          ? current.status
          : 'running'
  }
  return true
}

function applyAgentExecutionCompleted(next: ChatItem[], event: AgentEventSummary): boolean {
  const details = agentResultDetails(event.result)
  if (
    event.type !== 'agent_execution_completed' &&
    !(event.type === 'tool_execution_end' && details)
  ) {
    return false
  }
  const index = ensureAgentExecutionItem(next, event)
  const current = next[index]
  if (current.role !== 'agent_execution') return true
  const finalReport =
    typeof event.finalReport === 'string' ? event.finalReport : extractToolText(event.result)
  const completedAt = event.createdAt
  const durationMs = durationBetween(current.createdAt, event)
  const artifact = outputArtifactFrom(event.finalReportArtifact)
  next[index] = {
    ...current,
    agentName:
      event.agentName ?? (typeof details?.agent === 'string' ? details.agent : current.agentName),
    status: event.isError ? 'error' : 'done',
    ...(event.cancelled === true ? { cancelled: true } : {}),
    ...(finalReport ? { finalReport } : {}),
    ...(typeof event.finalReportPath === 'string'
      ? { finalReportPath: event.finalReportPath }
      : {}),
    ...(typeof event.finalReportBytes === 'number'
      ? { finalReportBytes: event.finalReportBytes }
      : {}),
    ...(event.finalReportTruncated === true ? { finalReportTruncated: true } : {}),
    ...(artifact ? { finalReportArtifact: artifact } : {}),
    ...(typeof event.toolCalls === 'number'
      ? { toolCalls: event.toolCalls }
      : typeof details?.toolCalls === 'number'
        ? { toolCalls: details.toolCalls }
        : {}),
    ...(event.isError && (event.error || finalReport) ? { error: event.error || finalReport } : {}),
    ...completedAtField(completedAt),
    ...(durationMs !== undefined ? { durationMs } : {})
  }
  return true
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

  const workspaceChanges = workspaceChangesItemFromPhiTimelineEvent(event)
  if (workspaceChanges) {
    if (!next.some((item) => item.id === workspaceChanges.id)) next.push(workspaceChanges)
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  const planReview = planReviewItemFromEvent(event)
  if (planReview) {
    if (!next.some((item) => item.id === planReview.id)) next.push(planReview)
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }
  if (applyPlanReviewDecision(next, event)) {
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  const presentedFiles = presentedFilesItemFromPhiTimelineEvent(event)
  if (presentedFiles) {
    if (!next.some((item) => item.id === presentedFiles.id)) next.push(presentedFiles)
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
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

  if (
    event.type === 'agent_execution_started' ||
    (event.type === 'tool_execution_start' &&
      isAgentToolName(event.toolName) &&
      agentTaskFromArgs(event.args) !== undefined)
  ) {
    const item = agentExecutionItemFromStart(event)
    if (item && !next.some((current) => current.id === item.id)) {
      next.push(item)
    }
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (applyAgentExecutionBackground(next, event)) {
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (applyAgentExecutionSteered(next, event)) {
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (applyAgentExecutionStep(next, event)) {
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (applyAgentExecutionCompleted(next, event)) {
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (event.type === 'provider_tool_call_completed' && typeof event.toolCallId === 'string') {
    const existingIndex = next.findIndex((item) => item.id === event.toolCallId)
    const existing = existingIndex >= 0 ? next[existingIndex] : null
    if (existing?.role === 'tool') {
      next[existingIndex] = {
        ...existing,
        output: event.output ?? existing.output,
        ...(event.outputPath ? { outputPath: event.outputPath } : {}),
        ...(event.outputBytes !== undefined ? { outputBytes: event.outputBytes } : {}),
        ...(event.outputTruncated !== undefined ? { outputTruncated: event.outputTruncated } : {}),
        ...(event.outputArtifact ? { outputArtifact: event.outputArtifact } : {}),
        status: event.isError ? 'error' : 'done',
        ...completedAtField(event.createdAt)
      }
    } else if (existingIndex < 0) {
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
        toolName: typeof event.toolName === 'string' ? event.toolName : 'tool',
        argsPreview: toolArgsPreview(event.args),
        argsJson,
        output: event.output ?? '',
        ...(event.outputPath ? { outputPath: event.outputPath } : {}),
        ...(event.outputBytes !== undefined ? { outputBytes: event.outputBytes } : {}),
        ...(event.outputTruncated !== undefined ? { outputTruncated: event.outputTruncated } : {}),
        ...(event.outputArtifact ? { outputArtifact: event.outputArtifact } : {}),
        status: event.isError ? 'error' : 'done',
        ...createdAtField(event.createdAt),
        ...completedAtField(event.createdAt)
      })
    }
    return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
  }

  if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
    const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
    const existingIndex = next.findIndex((item) => item.id === event.toolCallId)
    if (existingIndex >= 0 && next[existingIndex].role === 'tool') {
      next[existingIndex] = { ...next[existingIndex], status: 'running' }
      return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
    }
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
          ...(isTodoToolName(current.toolName)
            ? { todo: extractTodoSnapshot(event.result) ?? current.todo }
            : {}),
          status: event.isError ? 'error' : 'done',
          ...completedAtField(event.createdAt),
          ...(durationMs !== undefined ? { durationMs } : {})
        }
      }
    }
    if (event.type === 'tool_execution_end') {
      const uiBlocks =
        uiBlocksItemFromToolEvent(event) ?? unavailableUiBlocksItemFromToolEvent(event)
      if (uiBlocks && !next.some((item) => item.id === uiBlocks.id)) next.push(uiBlocks)
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
    if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_end') {
      const contentIndex = ame.contentIndex ?? 0
      const call = ame.partial?.content?.[contentIndex] ?? event.message.content?.[contentIndex]
      if (call?.type === 'toolCall' && typeof call.id === 'string') {
        const toolName = call.name ?? 'tool'
        if (
          isWrapperToolName(toolName) ||
          (isAgentToolName(toolName) && agentTaskFromArgs(call.arguments) !== undefined)
        ) {
          return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
        }
        let argsJson = ''
        try {
          argsJson = JSON.stringify(call.arguments, null, 2) ?? ''
        } catch {
          argsJson = ''
        }
        const existingIndex = next.findIndex((item) => item.id === call.id)
        if (existingIndex >= 0 && next[existingIndex].role === 'tool') {
          next[existingIndex] = {
            ...next[existingIndex],
            toolName,
            argsPreview: toolArgsPreview(call.arguments),
            argsJson
          }
        } else if (existingIndex < 0) {
          next.push({
            id: call.id,
            role: 'tool',
            ...runIdField(event.runId),
            toolName,
            argsPreview: toolArgsPreview(call.arguments),
            argsJson,
            output: '',
            status: 'running',
            ...createdAtField(event.createdAt)
          })
        }
      }
      return { messages: next, textBlockIds, thinkingBlockIds, thinkingStartedAtMs, nextId }
    }
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
