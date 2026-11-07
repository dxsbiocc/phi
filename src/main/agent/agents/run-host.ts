import type { PersistedToolOutput } from '../session/session-store'
import type { UiLanguage } from '../../../shared/uiLanguage'
import {
  agentRunNotice,
  isAgentRunEndState,
  type AgentRunFinishedEvent
} from '../../../shared/agentRunNotice'

import { isRecord } from '../../../shared/guards'
import { isFinalAgentRunState, type AgentRunSnapshot } from './registry'
import type { AgentReportStatus } from './report'

/**
 * The main-process side of a background agent run ending. The runs live in the
 * agent worker (one registry per conversation); when one ends it tells the main
 * process here, because only the main process knows the conversation on screen,
 * can persist to its timeline, notify the user and wake the main agent. Every
 * effect on the app is injected, and the worker is trusted no further than its JSON.
 */

export const AGENT_RUN_HOST_METHODS = {
  finished: 'agentRun.finished',
  reported: 'agentRun.reported',
  step: 'agentRun.step',
  nativeTaskStarted: 'agentRun.nativeTaskStarted',
  nativeTaskBackground: 'agentRun.nativeTaskBackground',
  nativeTaskStep: 'agentRun.nativeTaskStep',
  nativeTaskFinished: 'agentRun.nativeTaskFinished'
} as const

/** An event written to a conversation's timeline. */
export type AgentRunHostEvent = { type: string; [key: string]: unknown }
export type AgentRunHostCompletion = Pick<AgentRunSnapshot, 'id' | 'state'> &
  Partial<Omit<AgentRunSnapshot, 'id' | 'state'>>

const MAX_REPORT_LENGTH = 20000
const MAX_TASK_LENGTH = 500
const REPORT_STATUSES = new Set<AgentReportStatus>([
  'completed',
  'partial',
  'not_found',
  'blocked',
  'failed'
])

export interface AgentRunHostDeps {
  /** Maps the runtime session that started the run to its Phi conversation, if it is still known. */
  resolveSession: (
    originSessionId: string | undefined
  ) => { phiSessionId: string; cwd: string } | undefined
  /** Persists an event in that conversation's timeline and returns the stored form. */
  appendToSession: (phiSessionId: string, event: AgentRunHostEvent) => Record<string, unknown>
  sendToWindow: (payload: Record<string, unknown>) => void
  isAppFocused: () => boolean
  showOsNotification: (notification: { title: string; body: string }) => void
  getUiLanguage?: () => UiLanguage
  /** Decides whether to wake the main agent (see `run-continue.ts`); a throw here is contained. */
  continueConversation?: (phiSessionId: string, event: AgentRunFinishedEvent) => void
  /** Strips secrets from text that came out of an agent session. */
  redact: (text: string) => string
  /** Keeps a long step output in a file and returns what goes into the timeline (a preview). */
  persistStepOutput: (
    phiSessionId: string,
    toolCallId: string,
    stepId: string,
    output: string
  ) => PersistedToolOutput | null
  /** Strips secrets from structured data (a step's arguments). */
  redactValue: (value: unknown) => unknown
  /** The main agent was handed this run's outcome, so it needs no wake-up for it. */
  markReported: (phiSessionId: string, agentRunId: string) => void
  /** A new run with this id has just ended; any earlier receipt for that id is stale. */
  clearReported: (phiSessionId: string, agentRunId: string) => void
  /** Completes a plan step without creating a chat card, timeline event, wake-up, or notification. */
  deliverHostRun: (runtimeSessionId: string, run: AgentRunHostCompletion) => boolean
}

function requireString(
  record: Record<string, unknown> | undefined,
  key: string,
  label = key
): string {
  const value = record?.[key]
  if (typeof value !== 'string' || !value) throw new Error(`Missing required parameter: ${label}`)
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

function validOptionalField(
  value: Record<string, unknown>,
  key: string,
  type: 'string' | 'number'
): boolean {
  return value[key] === undefined || typeof value[key] === type
}

function hasValidRequiredHostRunFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.agent === 'string' &&
    Boolean(value.agent) &&
    typeof value.task === 'string' &&
    Boolean(value.task) &&
    isFinalAgentRunState(value.state) &&
    typeof value.background === 'boolean' &&
    typeof value.startedAt === 'number'
  )
}

function hasValidOptionalHostRunFields(value: Record<string, unknown>): boolean {
  const validMissingInputs =
    value.missingInputs === undefined ||
    (Array.isArray(value.missingInputs) &&
      value.missingInputs.every((item) => typeof item === 'string'))
  return (
    validOptionalField(value, 'completedAt', 'number') &&
    validOptionalField(value, 'toolCalls', 'number') &&
    validOptionalField(value, 'report', 'string') &&
    validOptionalField(value, 'error', 'string') &&
    validOptionalField(value, 'displayName', 'string') &&
    (value.reportStatus === undefined ||
      REPORT_STATUSES.has(value.reportStatus as AgentReportStatus)) &&
    validMissingInputs
  )
}

function hasValidHostRunFields(value: Record<string, unknown>): boolean {
  return hasValidRequiredHostRunFields(value) && hasValidOptionalHostRunFields(value)
}

function hostRunSnapshot(
  value: Record<string, unknown>,
  id: string,
  redact: (text: string) => string
): AgentRunHostCompletion {
  if (!hasValidHostRunFields(value)) {
    return { id, state: 'error', origin: 'host', error: 'Invalid completion from agent runtime' }
  }
  const state = value.state as AgentRunSnapshot['state']
  const report = optionalString(value, 'report')
  const error = optionalString(value, 'error')
  const reportStatus = REPORT_STATUSES.has(value.reportStatus as AgentReportStatus)
    ? (value.reportStatus as AgentReportStatus)
    : undefined
  const missingInputs = Array.isArray(value.missingInputs)
    ? value.missingInputs.filter((item): item is string => typeof item === 'string')
    : undefined
  const displayName = optionalString(value, 'displayName')
  return {
    id,
    agent: requireString(value, 'agent', 'run.agent'),
    ...(displayName ? { displayName } : {}),
    task: requireString(value, 'task', 'run.task'),
    state,
    background: value.background as boolean,
    origin: 'host',
    startedAt: value.startedAt as number,
    ...(typeof value.completedAt === 'number' ? { completedAt: value.completedAt } : {}),
    ...(typeof value.toolCalls === 'number' ? { toolCalls: value.toolCalls } : {}),
    ...(report ? { report: redact(report) } : {}),
    ...(reportStatus ? { reportStatus } : {}),
    ...(missingInputs ? { missingInputs } : {}),
    ...(error ? { error: redact(error) } : {})
  }
}

function seconds(record: Record<string, unknown>): number {
  const { startedAt, completedAt } = record
  if (typeof startedAt !== 'number' || typeof completedAt !== 'number') return 0
  return Math.max(0, Math.round((completedAt - startedAt) / 1000))
}

function capReport(report: string): string {
  return report.length > MAX_REPORT_LENGTH
    ? `${report.slice(0, MAX_REPORT_LENGTH)}\n… (report truncated)`
    : report
}

function parseFinished(
  params: unknown,
  redact: (text: string) => string
): { originSessionId: string; event: AgentRunFinishedEvent; toolCallId?: string } {
  const root = isRecord(params) ? params : undefined
  const originSessionId = requireString(root, 'originSessionId')
  const run = root?.run
  if (!isRecord(run)) throw new Error('Missing required parameter: run')
  const agentRunId = requireString(run, 'id', 'run.id')
  const agent = requireString(run, 'agent', 'run.agent')
  const displayName = optionalString(run, 'displayName') ?? agent
  const state = run.state
  if (!isAgentRunEndState(state)) throw new Error(`Invalid run.state: ${String(state)}`)

  const report = optionalString(run, 'report')
  const error = optionalString(run, 'error')
  const toolCallId = optionalString(run, 'toolCallId')
  return {
    originSessionId,
    ...(toolCallId ? { toolCallId } : {}),
    event: {
      type: 'agent_run_finished',
      agentRunId,
      agent: displayName,
      state,
      task: redact((optionalString(run, 'task') ?? '').slice(0, MAX_TASK_LENGTH)),
      elapsedSeconds: seconds(run),
      ...(typeof run.toolCalls === 'number' ? { toolCalls: run.toolCalls } : {}),
      ...(report ? { report: redact(capReport(report)) } : {}),
      ...(error ? { error: redact(error) } : {})
    }
  }
}

function sessionEvent(
  deps: AgentRunHostDeps,
  phiSessionId: string,
  cwd: string,
  event: AgentRunHostEvent
): void {
  const stored = deps.appendToSession(phiSessionId, event)
  deps.sendToWindow({ source: 'phi', ...stored, phiSessionId, cwd })
}

function nativeTaskCardId(nativeTaskId: string): string {
  return `native-task:${nativeTaskId}`
}

function nativeTaskOrigin(
  deps: AgentRunHostDeps,
  params: unknown
): {
  root: Record<string, unknown>
  origin: { phiSessionId: string; cwd: string } | undefined
  originSessionId: string
  nativeTaskId: string
  agent: string
  toolCallId: string
} {
  const root = isRecord(params) ? params : undefined
  const originSessionId = requireString(root, 'originSessionId')
  const nativeTaskId = requireString(root, 'nativeTaskId')
  const agent = requireString(root, 'agent')
  return {
    root: root!,
    origin: deps.resolveSession(originSessionId),
    originSessionId,
    nativeTaskId,
    agent,
    toolCallId: nativeTaskCardId(nativeTaskId)
  }
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

async function handleNativeTaskStarted(deps: AgentRunHostDeps, params: unknown): Promise<unknown> {
  const parsed = nativeTaskOrigin(deps, params)
  if (!parsed.origin) return { ok: true }
  const task = requireString(parsed.root, 'task')
  const parentToolCallId = requireString(parsed.root, 'parentToolCallId')
  sessionEvent(deps, parsed.origin.phiSessionId, parsed.origin.cwd, {
    type: 'agent_execution_started',
    toolCallId: parsed.toolCallId,
    agentName: parsed.agent,
    task: deps.redact(task.slice(0, MAX_TASK_LENGTH)),
    args: deps.redactValue({ task, parentToolCallId }),
    ...(validTimestamp(parsed.root.createdAt) ? { createdAt: parsed.root.createdAt } : {})
  })
  return { ok: true }
}

async function handleNativeTaskBackground(
  deps: AgentRunHostDeps,
  params: unknown
): Promise<unknown> {
  const parsed = nativeTaskOrigin(deps, params)
  if (!parsed.origin) return { ok: true }
  sessionEvent(deps, parsed.origin.phiSessionId, parsed.origin.cwd, {
    type: 'agent_execution_background',
    toolCallId: parsed.toolCallId,
    agentName: parsed.agent,
    ...(validTimestamp(parsed.root.createdAt) ? { createdAt: parsed.root.createdAt } : {})
  })
  return { ok: true }
}

function nativeTaskPersistedStepFields(
  persisted: PersistedToolOutput | null
): Record<string, unknown> {
  if (!persisted) return {}
  return {
    output: persisted.outputPreview,
    outputBytes: persisted.outputBytes,
    ...(persisted.outputPath ? { outputPath: persisted.outputPath } : {}),
    ...(persisted.truncated ? { outputTruncated: true } : {}),
    ...(persisted.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {})
  }
}

function nativeTaskStepTimingFields(step: Record<string, unknown>): Record<string, unknown> {
  const durationMs = nonNegativeNumber(step.durationMs)
  return {
    ...(validTimestamp(step.createdAt) ? { createdAt: step.createdAt } : {}),
    ...(validTimestamp(step.completedAt) ? { completedAt: step.completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {})
  }
}

function nativeTaskStepEvent(
  deps: AgentRunHostDeps,
  parsed: ReturnType<typeof nativeTaskOrigin>,
  step: Record<string, unknown>,
  persisted: PersistedToolOutput | null
): AgentRunHostEvent {
  const stepId = requireString(step, 'id', 'step.id')
  const status =
    step.status === 'done' || step.status === 'error' || step.status === 'running'
      ? step.status
      : 'running'
  return {
    type: 'agent_execution_step',
    toolCallId: parsed.toolCallId,
    agentName: parsed.agent,
    step: {
      id: stepId,
      toolName: requireString(step, 'toolName', 'step.toolName'),
      status,
      ...(step.args !== undefined ? { args: deps.redactValue(step.args) } : {}),
      ...nativeTaskPersistedStepFields(persisted),
      ...(typeof step.error === 'string' && step.error ? { error: deps.redact(step.error) } : {}),
      ...nativeTaskStepTimingFields(step)
    }
  }
}

async function handleNativeTaskStep(deps: AgentRunHostDeps, params: unknown): Promise<unknown> {
  const parsed = nativeTaskOrigin(deps, params)
  if (!parsed.origin || !isRecord(parsed.root.step)) return { ok: true }
  const step = parsed.root.step
  const stepId = requireString(step, 'id', 'step.id')
  const output = typeof step.output === 'string' ? deps.redact(step.output) : ''
  const persisted = output
    ? deps.persistStepOutput(
        parsed.origin.phiSessionId,
        parsed.toolCallId,
        `${parsed.nativeTaskId}-${stepId}`,
        output
      )
    : null
  sessionEvent(
    deps,
    parsed.origin.phiSessionId,
    parsed.origin.cwd,
    nativeTaskStepEvent(deps, parsed, step, persisted)
  )
  return { ok: true }
}

function nativeTaskFinishedEvent(
  deps: AgentRunHostDeps,
  parsed: ReturnType<typeof nativeTaskOrigin>,
  state: AgentRunFinishedEvent['state'],
  persisted: PersistedToolOutput | null,
  error: string | undefined
): AgentRunHostEvent {
  const durationMs = nonNegativeNumber(parsed.root.durationMs)
  const toolCalls = nonNegativeInteger(parsed.root.toolCalls)
  return {
    type: 'agent_execution_completed',
    toolCallId: parsed.toolCallId,
    agentName: parsed.agent,
    isError: state === 'error',
    ...(state === 'cancelled' ? { cancelled: true } : {}),
    ...(persisted
      ? { finalReport: persisted.outputPreview, finalReportBytes: persisted.outputBytes }
      : {}),
    ...(persisted?.outputPath ? { finalReportPath: persisted.outputPath } : {}),
    ...(persisted?.truncated ? { finalReportTruncated: true } : {}),
    ...(persisted?.outputArtifact ? { finalReportArtifact: persisted.outputArtifact } : {}),
    ...(state === 'error' && error ? { error: deps.redact(error) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(validTimestamp(parsed.root.createdAt) ? { createdAt: parsed.root.createdAt } : {})
  }
}

async function handleNativeTaskFinished(deps: AgentRunHostDeps, params: unknown): Promise<unknown> {
  const parsed = nativeTaskOrigin(deps, params)
  if (!parsed.origin) return { ok: true }
  const state = parsed.root.state
  if (!isAgentRunEndState(state)) throw new Error(`Invalid native task state: ${String(state)}`)
  const report = optionalString(parsed.root, 'report')
  const error = optionalString(parsed.root, 'error')
  const persisted = report
    ? deps.persistStepOutput(
        parsed.origin.phiSessionId,
        parsed.toolCallId,
        `${parsed.nativeTaskId}-final`,
        deps.redact(capReport(report))
      )
    : null
  sessionEvent(
    deps,
    parsed.origin.phiSessionId,
    parsed.origin.cwd,
    nativeTaskFinishedEvent(deps, parsed, state, persisted, error)
  )
  return { ok: true }
}

function stepEvent(
  deps: AgentRunHostDeps,
  phiSessionId: string,
  input: {
    originSessionId: string
    toolCallId: string
    agent: string
    agentRunId: string
    step: Record<string, unknown>
    stepId: string
  }
): AgentRunHostEvent {
  const { step, stepId } = input
  const output = typeof step.output === 'string' ? step.output : ''
  const persisted = output
    ? deps.persistStepOutput(phiSessionId, input.toolCallId, stepId, output)
    : null
  const status =
    step.status === 'done' || step.status === 'error' || step.status === 'running'
      ? step.status
      : 'running'
  const error =
    typeof step.error === 'string' && step.error
      ? deps.redact(step.error)
      : status === 'error' && output
        ? deps.redact(output)
        : undefined
  return {
    type: 'agent_execution_step',
    toolCallId: input.toolCallId,
    agentName: input.agent,
    agentRunId: input.agentRunId,
    agentSessionId: input.originSessionId,
    step: {
      id: stepId,
      toolName: typeof step.toolName === 'string' && step.toolName ? step.toolName : 'tool',
      status,
      ...(step.args !== undefined ? { args: deps.redactValue(step.args) } : {}),
      ...(persisted ? { output: persisted.outputPreview } : {}),
      ...(persisted?.outputPath ? { outputPath: persisted.outputPath } : {}),
      ...(persisted ? { outputBytes: persisted.outputBytes } : {}),
      ...(persisted?.truncated ? { outputTruncated: true } : {}),
      ...(persisted?.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {}),
      ...(error ? { error } : {}),
      ...(typeof step.createdAt === 'string' ? { createdAt: step.createdAt } : {}),
      ...(typeof step.completedAt === 'string' ? { completedAt: step.completedAt } : {})
    }
  }
}

function finishSession(
  deps: AgentRunHostDeps,
  origin: { phiSessionId: string; cwd: string },
  originSessionId: string,
  event: AgentRunFinishedEvent,
  toolCallId?: string
): void {
  deps.clearReported(origin.phiSessionId, event.agentRunId)
  try {
    if (toolCallId) {
      sessionEvent(deps, origin.phiSessionId, origin.cwd, {
        type: 'agent_execution_completed',
        toolCallId,
        agentName: event.agent,
        agentRunId: event.agentRunId,
        agentSessionId: originSessionId,
        // A run somebody stopped did not fail: the card says "cancelled", not an error.
        isError: event.state === 'error',
        ...(event.state === 'cancelled' ? { cancelled: true } : {}),
        ...(event.report ? { finalReport: event.report } : {}),
        ...(event.toolCalls !== undefined ? { toolCalls: event.toolCalls } : {}),
        ...(event.state === 'error' && event.error ? { error: event.error } : {})
      })
    }
  } catch {
    // The final event and notice remain independent fallbacks.
  }
  try {
    sessionEvent(deps, origin.phiSessionId, origin.cwd, { ...event })
  } catch {
    // The OS notification below still tells the user.
  }
  try {
    deps.continueConversation?.(origin.phiSessionId, event)
  } catch {
    // Waking the agent is best-effort.
  }
}

async function handleFinished(deps: AgentRunHostDeps, params: unknown): Promise<unknown> {
  const root = isRecord(params) ? params : undefined
  const run = root?.run
  if (isRecord(run) && run.origin === 'host') {
    const originSessionId = requireString(root, 'originSessionId')
    const id = requireString(run, 'id', 'run.id')
    deps.deliverHostRun(originSessionId, hostRunSnapshot(run, id, deps.redact))
    return { ok: true }
  }
  const { originSessionId, event, toolCallId } = parseFinished(params, deps.redact)
  const origin = deps.resolveSession(originSessionId)
  if (origin) finishSession(deps, origin, originSessionId, event, toolCallId)
  if (event.state !== 'cancelled' && !deps.isAppFocused()) {
    try {
      deps.showOsNotification(agentRunNotice(event, deps.getUiLanguage?.()))
    } catch {
      // Notifications are best-effort (unsupported platform, permission denied).
    }
  }
  return { ok: true }
}

async function handleStep(deps: AgentRunHostDeps, params: unknown): Promise<unknown> {
  const root = isRecord(params) ? params : undefined
  const originSessionId = requireString(root, 'originSessionId')
  const run = root?.run
  if (!isRecord(run)) throw new Error('Missing required parameter: run')
  const agentRunId = requireString(run, 'id', 'run.id')
  const agent = requireString(run, 'agent', 'run.agent')
  const displayName = optionalString(run, 'displayName') ?? agent
  const step = root?.step
  if (!isRecord(step)) throw new Error('Missing required parameter: step')
  const stepId = requireString(step, 'id', 'step.id')
  const toolCallId = optionalString(run, 'toolCallId')
  const origin = deps.resolveSession(originSessionId)
  if (!origin || !toolCallId) return { ok: true }
  try {
    sessionEvent(
      deps,
      origin.phiSessionId,
      origin.cwd,
      stepEvent(deps, origin.phiSessionId, {
        originSessionId,
        toolCallId,
        agent: displayName,
        agentRunId,
        step,
        stepId
      })
    )
  } catch {
    // Progress is best-effort; the run itself is unaffected.
  }
  return { ok: true }
}

async function handleReported(deps: AgentRunHostDeps, params: unknown): Promise<unknown> {
  const root = isRecord(params) ? params : undefined
  const originSessionId = requireString(root, 'originSessionId')
  const runId = requireString(root, 'runId')
  const origin = deps.resolveSession(originSessionId)
  if (origin) deps.markReported(origin.phiSessionId, runId)
  return { ok: true }
}

export function agentRunHostHandlers(
  deps: AgentRunHostDeps
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    [AGENT_RUN_HOST_METHODS.finished]: (params) => handleFinished(deps, params),
    [AGENT_RUN_HOST_METHODS.step]: (params) => handleStep(deps, params),
    [AGENT_RUN_HOST_METHODS.reported]: (params) => handleReported(deps, params),
    [AGENT_RUN_HOST_METHODS.nativeTaskStarted]: (params) => handleNativeTaskStarted(deps, params),
    [AGENT_RUN_HOST_METHODS.nativeTaskBackground]: (params) =>
      handleNativeTaskBackground(deps, params),
    [AGENT_RUN_HOST_METHODS.nativeTaskStep]: (params) => handleNativeTaskStep(deps, params),
    [AGENT_RUN_HOST_METHODS.nativeTaskFinished]: (params) => handleNativeTaskFinished(deps, params)
  }
}
