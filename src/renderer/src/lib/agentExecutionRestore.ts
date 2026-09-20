import type { ChatItem } from '../types'
import type { AgentExecutionItem, AgentExecutionStep } from './agentExecutionTypes'

function runIdField(runId?: unknown): { runId: string } | Record<string, never> {
  return typeof runId === 'string' && runId ? { runId } : {}
}

function createdAtField(createdAt?: string): { createdAt: string } | Record<string, never> {
  return typeof createdAt === 'string' ? { createdAt } : {}
}

function completedAtField(completedAt?: string): { completedAt: string } | Record<string, never> {
  return typeof completedAt === 'string' ? { completedAt } : {}
}

function durationBetween(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) return undefined
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, end - start)
}

function argsJsonFrom(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return ''
  }
}

function toolArgsPreview(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  const preferred = ['command', 'path', 'file_path', 'pattern', 'code', 'query']
  for (const key of preferred) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string
  }
  const firstString = Object.values(record).find(
    (item): item is string => typeof item === 'string' && item.length > 0
  )
  return firstString ?? ''
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

export function agentExecutionIndex(items: ChatItem[], toolCallId: string | undefined): number {
  if (!toolCallId) return -1
  return items.findIndex((item) => item.role === 'agent_execution' && item.id === toolCallId)
}

export function agentExecutionFromTimelineEvent(message: {
  runId?: string
  toolCallId?: string
  agentName?: string
  task?: string
  args?: unknown
  createdAt?: string
}): AgentExecutionItem | null {
  if (!message.toolCallId || !message.agentName) return null
  const args = message.args ?? (message.task ? { task: message.task } : undefined)
  const argsJson = argsJsonFrom(args)
  return {
    id: message.toolCallId,
    role: 'agent_execution',
    ...runIdField(message.runId),
    agentName: message.agentName,
    task: message.task ?? '',
    argsPreview: message.task || toolArgsPreview(args),
    argsJson,
    status: 'running',
    steps: [],
    ...createdAtField(message.createdAt)
  }
}

function ensureAgentExecution(
  items: ChatItem[],
  message: {
    runId?: string
    toolCallId?: string
    agentName?: string
    createdAt?: string
  }
): number {
  const existingIndex = agentExecutionIndex(items, message.toolCallId)
  if (existingIndex >= 0) return existingIndex
  const id = message.toolCallId ?? `agent-${items.length}`
  items.push({
    id,
    role: 'agent_execution',
    ...runIdField(message.runId),
    agentName: message.agentName ?? 'Agent',
    task: '',
    argsPreview: '',
    argsJson: '',
    status: 'running',
    steps: [],
    ...createdAtField(message.createdAt)
  })
  return items.length - 1
}

function agentStepFromTimelineEvent(message: {
  toolCallId?: string
  step?: unknown
  createdAt?: string
}): (Partial<AgentExecutionStep> & Pick<AgentExecutionStep, 'id' | 'toolName' | 'status'>) | null {
  if (!message.step || typeof message.step !== 'object' || Array.isArray(message.step)) {
    return null
  }
  const step = message.step as Record<string, unknown>
  const id =
    typeof step.id === 'string' && step.id
      ? step.id
      : message.toolCallId
        ? `${message.toolCallId}:step`
        : ''
  if (!id) return null
  const toolName = typeof step.toolName === 'string' && step.toolName ? step.toolName : 'tool'
  const status =
    step.status === 'done' || step.status === 'error' || step.status === 'running'
      ? step.status
      : 'running'
  const args = step.args
  const argsJson = argsJsonFrom(args)
  const outputArtifact = toolOutputArtifactFrom(step.outputArtifact)
  const createdAt =
    typeof step.createdAt === 'string'
      ? step.createdAt
      : status === 'running'
        ? message.createdAt
        : undefined
  const completedAt = typeof step.completedAt === 'string' ? step.completedAt : undefined
  const durationMs =
    typeof step.durationMs === 'number' ? step.durationMs : durationBetween(createdAt, completedAt)

  return {
    id,
    toolName,
    status,
    ...(args !== undefined ? { argsPreview: toolArgsPreview(args), argsJson } : {}),
    ...(typeof step.output === 'string' ? { output: step.output } : {}),
    ...(typeof step.outputPath === 'string' ? { outputPath: step.outputPath } : {}),
    ...(typeof step.outputBytes === 'number' ? { outputBytes: step.outputBytes } : {}),
    ...(step.outputTruncated === true ? { outputTruncated: true } : {}),
    ...(outputArtifact ? { outputArtifact } : {}),
    ...(typeof step.error === 'string' && step.error ? { error: step.error } : {}),
    ...createdAtField(createdAt),
    ...completedAtField(completedAt),
    ...(durationMs !== undefined ? { durationMs } : {})
  }
}

function mergeAgentStep(
  current: AgentExecutionStep | undefined,
  incoming: Partial<AgentExecutionStep> & Pick<AgentExecutionStep, 'id' | 'toolName' | 'status'>
): AgentExecutionStep {
  const createdAt = incoming.createdAt ?? current?.createdAt
  const completedAt = incoming.completedAt ?? current?.completedAt
  const mergedDurationMs =
    incoming.durationMs ??
    (createdAt && completedAt ? durationBetween(createdAt, completedAt) : undefined) ??
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

type AgentRunRefMessage = { agentRunId?: unknown; agentSessionId?: unknown }

function agentRunRefFields(message: AgentRunRefMessage): {
  agentRunId?: string
  agentSessionId?: string
} {
  return {
    ...(typeof message.agentRunId === 'string' && message.agentRunId
      ? { agentRunId: message.agentRunId }
      : {}),
    ...(typeof message.agentSessionId === 'string' && message.agentSessionId
      ? { agentSessionId: message.agentSessionId }
      : {})
  }
}

export function applyAgentBackgroundTimelineEvent(
  items: ChatItem[],
  message: {
    runId?: string
    toolCallId?: string
    agentName?: string
    createdAt?: string
  } & AgentRunRefMessage
): void {
  const index = ensureAgentExecution(items, message)
  const current = items[index]
  if (current.role !== 'agent_execution') return
  items[index] = { ...current, ...agentRunRefFields(message), background: true }
}

export function applyAgentSteeredTimelineEvent(
  items: ChatItem[],
  message: {
    runId?: string
    toolCallId?: string
    agentName?: string
    text?: unknown
    createdAt?: string
  }
): void {
  const text = typeof message.text === 'string' ? message.text.trim() : ''
  if (!text) return
  const index = ensureAgentExecution(items, message)
  const current = items[index]
  if (current.role !== 'agent_execution') return
  items[index] = {
    ...current,
    steers: [...(current.steers ?? []), { text, ...createdAtField(message.createdAt) }]
  }
}

export function applyAgentStepTimelineEvent(
  items: ChatItem[],
  message: {
    runId?: string
    toolCallId?: string
    agentName?: string
    step?: unknown
    createdAt?: string
  } & AgentRunRefMessage
): void {
  const incoming = agentStepFromTimelineEvent(message)
  if (!incoming) return
  const index = ensureAgentExecution(items, message)
  const current = items[index]
  if (current.role !== 'agent_execution') return
  const stepIndex = current.steps.findIndex((step) => step.id === incoming.id)
  const steps =
    stepIndex >= 0
      ? current.steps.map((step, currentIndex) =>
          currentIndex === stepIndex ? mergeAgentStep(step, incoming) : step
        )
      : [...current.steps, mergeAgentStep(undefined, incoming)]
  items[index] = { ...current, ...agentRunRefFields(message), steps }
}

export function applyAgentCompletedTimelineEvent(
  items: ChatItem[],
  message: {
    runId?: string
    toolCallId?: string
    agentName?: string
    isError?: boolean
    cancelled?: boolean
    finalReport?: string
    finalReportPath?: string
    finalReportBytes?: number
    finalReportTruncated?: boolean
    finalReportArtifact?: unknown
    toolCalls?: number
    error?: string
    createdAt?: string
  }
): void {
  const index = ensureAgentExecution(items, message)
  const current = items[index]
  if (current.role !== 'agent_execution') return
  const finalReportArtifact = toolOutputArtifactFrom(message.finalReportArtifact)
  const durationMs = durationBetween(current.createdAt, message.createdAt)
  items[index] = {
    ...current,
    agentName: message.agentName ?? current.agentName,
    status: message.isError ? 'error' : 'done',
    ...(message.cancelled === true ? { cancelled: true } : {}),
    ...(typeof message.finalReport === 'string' ? { finalReport: message.finalReport } : {}),
    ...(typeof message.finalReportPath === 'string'
      ? { finalReportPath: message.finalReportPath }
      : {}),
    ...(typeof message.finalReportBytes === 'number'
      ? { finalReportBytes: message.finalReportBytes }
      : {}),
    ...(message.finalReportTruncated === true ? { finalReportTruncated: true } : {}),
    ...(finalReportArtifact ? { finalReportArtifact } : {}),
    ...(typeof message.toolCalls === 'number' ? { toolCalls: message.toolCalls } : {}),
    ...(typeof message.error === 'string' && message.error ? { error: message.error } : {}),
    ...completedAtField(message.createdAt),
    ...(durationMs !== undefined ? { durationMs } : {})
  }
}
