import { isRecord } from '../../../../shared/guards'
import {
  PLAN_MAX_REPLANS,
  PLAN_RUN_PAUSE_REASONS,
  PLAN_RUN_STATUSES,
  PLAN_STEP_STATUSES,
  type PlanRunEvent,
  type PlanRunPause,
  type PlanRunState,
  type PlanRunStatus,
  type PlanRunTransitionErrorCode,
  type PlanSpec,
  type PlanStep,
  type PlanStepState,
  type PlanStepStatus
} from '../../../../shared/planRunTypes'
import {
  normalizePlanStepReport,
  resolvePlanStepFailure,
  validatePlanStepReport
} from './failure-policy'
import { validatePlanSpec } from './plan-spec'

export type { PlanRunEvent, PlanRunTransitionErrorCode } from '../../../../shared/planRunTypes'
export class PlanRunTransitionError extends Error {
  constructor(
    readonly code: PlanRunTransitionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PlanRunTransitionError'
  }
}
function transitionError(code: PlanRunTransitionErrorCode, message: string): never {
  throw new PlanRunTransitionError(code, message)
}
function cloneStep(step: PlanStep): PlanStep {
  return {
    ...step,
    dependsOn: [...step.dependsOn],
    ...(step.writes ? { writes: [...step.writes] } : {})
  }
}
function cloneSpec(spec: PlanSpec): PlanSpec {
  return { version: 1, goal: spec.goal, steps: spec.steps.map(cloneStep) }
}
function pendingStep(): PlanStepState {
  return { status: 'pending', attempts: 0 }
}
export function createPlanRunState(input: {
  id: string
  sessionId: string
  spec: PlanSpec
  now: string
}): PlanRunState {
  const spec = cloneSpec(input.spec)
  return {
    id: input.id,
    sessionId: input.sessionId,
    spec,
    status: 'running',
    steps: Object.fromEntries(spec.steps.map((step) => [step.id, pendingStep()])),
    replans: 0,
    createdAt: input.now,
    updatedAt: input.now
  }
}
function requireStep(state: PlanRunState, stepId: string): PlanStepState {
  const step = state.steps[stepId]
  if (!step) transitionError('STEP_NOT_FOUND', `Plan step "${stepId}" does not exist.`)
  return step
}
function requireStepStatus(stepId: string, step: PlanStepState, allowed: PlanStepStatus[]): void {
  if (!allowed.includes(step.status))
    transitionError(
      'INVALID_STEP_TRANSITION',
      `Plan step "${stepId}" cannot transition from ${step.status}.`
    )
}
function finishIfComplete(state: PlanRunState): PlanRunState {
  if (state.status === 'stopped') return state
  const complete = Object.values(state.steps).every(
    (step) => step.status === 'done' || step.status === 'skipped'
  )
  return complete ? { ...state, status: 'completed', pause: undefined } : state
}
function settleRunStatus(state: PlanRunState): PlanRunState {
  const blocked =
    state.spec.steps.find(({ id }) => state.steps[id]?.status === 'unknown') ??
    state.spec.steps.find(({ id }) => {
      const status = state.steps[id]?.status
      return status === 'failed' || status === 'interrupted'
    })
  if (blocked) {
    const step = state.steps[blocked.id]!
    const reason =
      step.status === 'unknown'
        ? 'unknown'
        : step.status === 'interrupted'
          ? 'interrupted'
          : step.report?.missingInputs.length
            ? 'needs_input'
            : 'step_failed'
    return { ...state, status: 'paused', pause: { reason, stepId: blocked.id } }
  }
  if (state.pause?.reason === 'user') return state
  // A step problem supersedes a user pause; resolving it resumes instead of restoring that pause.
  return { ...state, status: 'running', pause: undefined }
}
function withStep(
  state: PlanRunState,
  stepId: string,
  step: PlanStepState,
  at: string
): PlanRunState {
  return { ...state, steps: { ...state.steps, [stepId]: step }, updatedAt: at }
}
function lastAliveAt(state: PlanRunState, step: PlanStepState, at: string): string {
  const upperMs = Date.parse(at)
  if (!Number.isFinite(upperMs)) return at
  const startedAt = step.startedAt
  const lowerMs = startedAt ? Date.parse(startedAt) : Number.NaN
  const candidate = step.lastSeenAt ?? state.updatedAt
  const candidateMs = Date.parse(candidate)
  const baseMs = Number.isFinite(candidateMs)
    ? candidateMs
    : Number.isFinite(lowerMs)
      ? lowerMs
      : upperMs
  const lowerBound = Number.isFinite(lowerMs) ? lowerMs : baseMs
  const clamped = Math.min(upperMs, Math.max(lowerBound, baseMs))
  if (Number.isFinite(candidateMs) && clamped === candidateMs) return candidate
  if (Number.isFinite(lowerMs) && clamped === lowerMs && startedAt) return startedAt
  return at
}
function reduceStepLaunched(
  state: PlanRunState,
  event: Extract<PlanRunEvent, { type: 'step_launched' }>
): PlanRunState {
  if (state.status !== 'running')
    transitionError('INVALID_RUN_STATUS', 'Steps can launch only while running.')
  const current = requireStep(state, event.stepId)
  requireStepStatus(event.stepId, current, ['pending', 'launching'])
  const next: PlanStepState = {
    status: 'running',
    attempts: current.status === 'launching' ? current.attempts : current.attempts + 1,
    ...(current.requestId ? { requestId: current.requestId } : {}),
    agentRunId: event.agentRunId,
    startedAt: event.at
  }
  return withStep(state, event.stepId, next, event.at)
}
function reduceLaunchRequested(
  state: PlanRunState,
  event: Extract<PlanRunEvent, { type: 'step_launch_requested' }>
): PlanRunState {
  if (state.status !== 'running')
    transitionError('INVALID_RUN_STATUS', 'Steps can launch only while running.')
  const current = requireStep(state, event.stepId)
  requireStepStatus(event.stepId, current, ['pending'])
  if (!event.requestId) transitionError('INVALID_STEP_TRANSITION', 'Launch request ID is required.')
  return withStep(
    state,
    event.stepId,
    {
      status: 'launching',
      attempts: current.attempts + 1,
      requestId: event.requestId,
      startedAt: event.at
    },
    event.at
  )
}
function reduceLaunchUnknown(
  state: PlanRunState,
  event: Extract<PlanRunEvent, { type: 'step_launch_unknown' }>
): PlanRunState {
  const current = requireStep(state, event.stepId)
  requireStepStatus(event.stepId, current, ['launching', 'running'])
  if (!current.requestId || current.requestId !== event.requestId)
    transitionError('INVALID_STEP_TRANSITION', 'Launch request ID does not match.')
  return withStep(
    state,
    event.stepId,
    { ...current, status: 'unknown', lastSeenAt: event.at },
    event.at
  )
}
function reduceLaunchQuiescent(
  state: PlanRunState,
  event: Extract<PlanRunEvent, { type: 'step_launch_quiescent' }>
): PlanRunState {
  const current = requireStep(state, event.stepId)
  requireStepStatus(event.stepId, current, ['unknown'])
  if (!current.requestId || current.requestId !== event.requestId)
    transitionError('INVALID_STEP_TRANSITION', 'Launch request ID does not match.')
  // The release happens after restart, so the event time is not when the step died.
  const finishedAt = lastAliveAt(state, current, event.at)
  return withStep(
    state,
    event.stepId,
    { ...current, status: 'interrupted', finishedAt, lastSeenAt: finishedAt },
    event.at
  )
}
function reduceStepInterrupted(
  state: PlanRunState,
  event: Extract<PlanRunEvent, { type: 'step_interrupted' }>
): PlanRunState {
  const current = requireStep(state, event.stepId)
  requireStepStatus(event.stepId, current, ['running', 'launching'])
  // At quit, the event time is the last moment the step was alive; a recorded
  // last-seen timestamp wins when it exists.
  const finishedAt = current.lastSeenAt ? lastAliveAt(state, current, event.at) : event.at
  return withStep(
    state,
    event.stepId,
    { ...current, status: 'interrupted', finishedAt, lastSeenAt: finishedAt },
    event.at
  )
}
function reduceStepSucceeded(
  state: PlanRunState,
  event: Extract<PlanRunEvent, { type: 'step_succeeded' }>
): PlanRunState {
  const current = requireStep(state, event.stepId)
  requireStepStatus(event.stepId, current, ['running'])
  const next: PlanStepState = {
    ...current,
    status: 'done',
    report: normalizePlanStepReport(event.report),
    error: undefined,
    finishedAt: event.at
  }
  return withStep(state, event.stepId, next, event.at)
}
function reduceFailure(
  state: PlanRunState,
  event: Extract<PlanRunEvent, { type: 'step_failed' | 'step_needs_input' }>
): PlanRunState {
  const current = requireStep(state, event.stepId)
  requireStepStatus(event.stepId, current, ['running'])
  const error = event.type === 'step_failed' ? event.error : undefined
  const next = resolvePlanStepFailure({
    current,
    ...(event.report ? { report: event.report } : {}),
    ...(error ? { error } : {}),
    at: event.at,
    needsInput: event.type === 'step_needs_input'
  })
  return withStep(state, event.stepId, next, event.at)
}
function reducePause(state: PlanRunState, at: string): PlanRunState {
  if (state.status !== 'running')
    transitionError('INVALID_RUN_STATUS', 'Only a running plan can be paused.')
  return { ...state, status: 'paused', pause: { reason: 'user' }, updatedAt: at }
}
function reduceResume(state: PlanRunState, at: string): PlanRunState {
  if (state.status !== 'paused' || state.pause?.reason !== 'user')
    transitionError('INVALID_RUN_STATUS', 'Only a user-paused plan can be resumed.')
  return { ...state, status: 'running', pause: undefined, updatedAt: at }
}
function requireNoUnknownLaunch(state: PlanRunState): void {
  if (Object.values(state.steps).some((step) => step.status === 'unknown')) {
    transitionError(
      'INVALID_STEP_TRANSITION',
      'An unknown remote launch must be reconciled before changing plan steps.'
    )
  }
}
function reduceRetry(state: PlanRunState, stepId: string, at: string): PlanRunState {
  if (state.status !== 'paused')
    transitionError('INVALID_RUN_STATUS', 'A step can retry only while paused.')
  requireNoUnknownLaunch(state)
  const current = requireStep(state, stepId)
  requireStepStatus(stepId, current, ['failed', 'interrupted'])
  const next: PlanStepState = { status: 'pending', attempts: current.attempts }
  return withStep(state, stepId, next, at)
}
function reduceSkip(state: PlanRunState, stepId: string, at: string): PlanRunState {
  requireNoUnknownLaunch(state)
  const current = requireStep(state, stepId)
  requireStepStatus(stepId, current, ['pending', 'failed', 'interrupted'])
  const next: PlanStepState = { ...current, status: 'skipped', finishedAt: at }
  return withStep(state, stepId, next, at)
}
function reduceStop(state: PlanRunState, at: string): PlanRunState {
  if (
    Object.values(state.steps).some(
      (step) => step.status === 'unknown' || step.status === 'launching'
    )
  ) {
    transitionError('INVALID_STEP_TRANSITION', 'An unresolved launch cannot be stopped safely.')
  }
  const steps = Object.fromEntries<PlanStepState>(
    Object.entries(state.steps).map<[string, PlanStepState]>(([id, step]) => [
      id,
      step.status === 'running' ? { ...step, status: 'cancelled', finishedAt: at } : step
    ])
  )
  return { ...state, status: 'stopped', steps, pause: undefined, updatedAt: at }
}
function comparableStep(step: PlanStep): unknown[] {
  return [
    step.id,
    step.title,
    step.instructions,
    step.acceptance,
    step.dependsOn,
    step.access,
    step.writes,
    step.agent
  ]
}
function sameStep(left: PlanStep, right: PlanStep): boolean {
  return JSON.stringify(comparableStep(left)) === JSON.stringify(comparableStep(right))
}
function validateReplacement(state: PlanRunState, spec: PlanSpec): PlanSpec {
  const result = validatePlanSpec(spec)
  if (!result.ok) {
    throw new PlanRunTransitionError('INVALID_REPLACEMENT', result.errors.join(' '))
  }
  if (result.spec.goal !== state.spec.goal) {
    throw new PlanRunTransitionError('INVALID_REPLACEMENT', 'Replacement cannot change plan goal.')
  }
  const replacements = new Map(result.spec.steps.map((step) => [step.id, step]))
  for (const step of state.spec.steps) {
    const started =
      state.steps[step.id]?.attempts !== 0 || state.steps[step.id]?.status !== 'pending'
    if (started && (!replacements.has(step.id) || !sameStep(step, replacements.get(step.id)!))) {
      throw new PlanRunTransitionError(
        'INVALID_REPLACEMENT',
        `Replacement cannot modify started step "${step.id}".`
      )
    }
  }
  return result.spec
}
function reduceReplacement(state: PlanRunState, spec: PlanSpec, at: string): PlanRunState {
  if (state.status !== 'paused') {
    throw new PlanRunTransitionError(
      'INVALID_RUN_STATUS',
      'Remaining steps can be replaced only while paused.'
    )
  }
  if (state.replans >= PLAN_MAX_REPLANS) {
    throw new PlanRunTransitionError('REPLAN_LIMIT_REACHED', 'Plan replan limit has been reached.')
  }
  if (Object.values(state.steps).some((step) => step.status === 'unknown')) {
    throw new PlanRunTransitionError(
      'INVALID_REPLACEMENT',
      'An unknown remote launch must be reconciled before replanning.'
    )
  }
  const nextSpec = validateReplacement(state, spec)
  const steps = Object.fromEntries<PlanStepState>(
    nextSpec.steps.map<[string, PlanStepState]>((step) => {
      const existing = state.steps[step.id]
      if (!existing || (existing.attempts === 0 && existing.status === 'pending')) {
        return [step.id, pendingStep()]
      }
      return [
        step.id,
        existing.status === 'failed' || existing.status === 'interrupted'
          ? { ...existing, status: 'skipped', finishedAt: at }
          : existing
      ]
    })
  )
  return {
    ...state,
    spec: nextSpec,
    steps,
    replans: state.replans + 1,
    updatedAt: at
  }
}
function reduceRecovery(state: PlanRunState, at: string): PlanRunState {
  const steps = { ...state.steps }
  for (const [id, step] of Object.entries(state.steps)) {
    if (step.status === 'unknown') {
      steps[id] = { ...step, lastSeenAt: lastAliveAt(state, step, at) }
      continue
    }
    if (step.status !== 'running' && step.status !== 'launching') continue
    const lastAlive = lastAliveAt(state, step, at)
    steps[id] = step.requestId
      ? { ...step, status: 'unknown', lastSeenAt: lastAlive }
      : { ...step, status: 'interrupted', finishedAt: lastAlive, lastSeenAt: lastAlive }
  }
  // Recovery itself is a new durable update, but it does not make the step live longer.
  return { ...state, steps, updatedAt: at }
}
type LaunchEvent = Extract<
  PlanRunEvent,
  { type: 'step_launch_requested' | 'step_launch_unknown' | 'step_launch_quiescent' }
>
function isLaunchEvent(event: PlanRunEvent): event is LaunchEvent {
  return (
    event.type === 'step_launch_requested' ||
    event.type === 'step_launch_unknown' ||
    event.type === 'step_launch_quiescent'
  )
}
function reduceLaunchEvent(state: PlanRunState, event: LaunchEvent): PlanRunState {
  switch (event.type) {
    case 'step_launch_requested':
      return reduceLaunchRequested(state, event)
    case 'step_launch_unknown':
      return reduceLaunchUnknown(state, event)
    case 'step_launch_quiescent':
      return reduceLaunchQuiescent(state, event)
  }
}
export function reducePlanRun(state: PlanRunState, event: PlanRunEvent): PlanRunState {
  if (state.status === 'completed' || state.status === 'stopped') {
    throw new PlanRunTransitionError('RUN_FINISHED', `Plan run is already ${state.status}.`)
  }
  if (isLaunchEvent(event))
    return finishIfComplete(settleRunStatus(reduceLaunchEvent(state, event)))
  let next: PlanRunState
  switch (event.type) {
    case 'step_launched':
      next = reduceStepLaunched(state, event)
      break
    case 'step_interrupted':
      next = reduceStepInterrupted(state, event)
      break
    case 'step_succeeded':
      next = reduceStepSucceeded(state, event)
      break
    case 'step_failed':
      next = reduceFailure(state, event)
      break
    case 'step_needs_input':
      next = reduceFailure(state, event)
      break
    case 'pause':
      next = reducePause(state, event.at)
      break
    case 'resume':
      next = reduceResume(state, event.at)
      break
    case 'retry_step':
      next = reduceRetry(state, event.stepId, event.at)
      break
    case 'skip_step':
      next = reduceSkip(state, event.stepId, event.at)
      break
    case 'stop':
      return reduceStop(state, event.at)
    case 'replace_remaining_steps':
      next = reduceReplacement(state, event.spec, event.at)
      break
    case 'recover_after_restart':
      next = reduceRecovery(state, event.at)
  }
  return finishIfComplete(settleRunStatus(next))
}
function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}
function optionalString(record: Record<string, unknown>, key: string): string | undefined | null {
  if (!(key in record)) return undefined
  return typeof record[key] === 'string' && record[key].length > 0 ? record[key] : null
}
function validStepFields(fields: Array<string | null | undefined>): boolean {
  if (fields.includes(null)) return false
  return fields.slice(2).every((value) => value === undefined || validTimestamp(value))
}
type ParsedStepFields = Pick<
  PlanStepState,
  'agentRunId' | 'requestId' | 'report' | 'error' | 'startedAt' | 'finishedAt' | 'lastSeenAt'
>
function parseStepFields(value: Record<string, unknown>): ParsedStepFields | null {
  const agentRunId = optionalString(value, 'agentRunId')
  const requestId = optionalString(value, 'requestId')
  const error = optionalString(value, 'error')
  const startedAt = optionalString(value, 'startedAt')
  const finishedAt = optionalString(value, 'finishedAt')
  const lastSeenAt = optionalString(value, 'lastSeenAt')
  if (
    !validStepFields([agentRunId, error, startedAt, finishedAt, lastSeenAt]) ||
    requestId === null
  )
    return null
  const report = 'report' in value ? validatePlanStepReport(value.report) : undefined
  if (report === null) return null
  return {
    ...(agentRunId ? { agentRunId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(report ? { report } : {}),
    ...(error ? { error } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {})
  }
}
function parseStepState(value: unknown): PlanStepState | null {
  if (!isRecord(value) || !PLAN_STEP_STATUSES.includes(value.status as PlanStepStatus)) return null
  if (!Number.isInteger(value.attempts) || (value.attempts as number) < 0) return null
  const fields = parseStepFields(value)
  if (!fields) return null
  const unresolved = value.status === 'launching' || value.status === 'unknown'
  if (unresolved && (!fields.requestId || value.attempts === 0)) return null
  if (value.status === 'pending' && fields.requestId) return null
  return { status: value.status as PlanStepStatus, attempts: value.attempts as number, ...fields }
}
function parsePause(value: unknown): PlanRunPause | null {
  if (!isRecord(value)) return null
  if (!PLAN_RUN_PAUSE_REASONS.includes(value.reason as PlanRunPause['reason'])) return null
  const stepId = optionalString(value, 'stepId')
  if (stepId === null) return null
  return { reason: value.reason as PlanRunPause['reason'], ...(stepId ? { stepId } : {}) }
}
function validRunHeader(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string' || typeof value.sessionId !== 'string') return false
  if (!value.id || !value.sessionId || !PLAN_RUN_STATUSES.includes(value.status as PlanRunStatus))
    return false
  if (!validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) return false
  return (
    Number.isInteger(value.replans) &&
    (value.replans as number) >= 0 &&
    (value.replans as number) <= PLAN_MAX_REPLANS
  )
}
function parseRunSteps(value: unknown, ids: string[]): Record<string, PlanStepState> | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== ids.length || keys.some((id) => !ids.includes(id))) return null
  const entries = ids.map((id) => [id, parseStepState(value[id])] as const)
  if (entries.some(([, step]) => !step)) return null
  return Object.fromEntries(entries) as Record<string, PlanStepState>
}
function validTerminalSteps(status: PlanRunStatus, steps: Record<string, PlanStepState>): boolean {
  if (status === 'completed')
    return Object.values(steps).every((step) => step.status === 'done' || step.status === 'skipped')
  if (status === 'stopped')
    return Object.values(steps).every(
      (step) => !['running', 'launching', 'unknown'].includes(step.status)
    )
  return true
}
export function validatePlanRunState(value: unknown): PlanRunState | null {
  if (!isRecord(value) || !validRunHeader(value)) return null
  const spec = validatePlanSpec(value.spec)
  if (!spec.ok) return null
  const steps = parseRunSteps(
    value.steps,
    spec.spec.steps.map((step) => step.id)
  )
  if (!steps) return null
  const pause = value.pause === undefined ? undefined : parsePause(value.pause)
  if (pause === null || (value.status === 'paused') !== Boolean(pause)) return null
  if (!validTerminalSteps(value.status as PlanRunStatus, steps)) return null
  return {
    id: value.id as string,
    sessionId: value.sessionId as string,
    spec: spec.spec,
    status: value.status as PlanRunStatus,
    steps,
    ...(pause ? { pause } : {}),
    replans: value.replans as number,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string
  }
}
