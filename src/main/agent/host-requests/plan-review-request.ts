import type { BrowserWindow } from 'electron'

import type { PhiHostRequestContext } from '../engine/types'
import type { AgentUserInteractionInput, waitForAgentUserInteraction } from '../user-interaction'
import { isRecord } from '../../../shared/guards'
import type { PlanSpec } from '../../../shared/planRunTypes'
import { validatePlanSpec } from '../plan/model/plan-spec'

export interface PlanReviewPromptRun {
  phiSessionId: string
  runId: string
  cwd: string
  projectId?: string
  sessionGeneration: number
  cancelled: boolean
}

interface PlanReviewProject {
  name?: string
  location: { kind: string }
}

interface PlanReviewSession {
  projectLocation?: { kind: string }
  workMode?: string
}

interface PlanReviewSubmittedEvent extends Record<string, unknown> {
  type: 'plan_review_submitted'
  runId: string
  reviewId: string
  title: string
  content: string
  planFilePath: string
  steps?: PlanSpec
}

interface PlanReviewDecidedEvent extends Record<string, unknown> {
  type: 'plan_review_decided'
  runId: string
  reviewId: string
  decision: PlanReviewDecision
  note?: string
  reason?: 'plan_start_failed' | 'review_expired'
}

type PlanReviewEvent = PlanReviewSubmittedEvent | PlanReviewDecidedEvent
type PlanReviewResponse = Awaited<ReturnType<typeof waitForAgentUserInteraction>>
type PlanReviewDecision = 'approve' | 'revise' | 'cancel'

export interface PlanReviewRequestDeps<StoredEvent> {
  fields: {
    optionalStringField(record: Record<string, unknown>, key: string): string | undefined
  }
  runs: {
    findByRuntimeSessionId(runtimeSessionId: string): PlanReviewPromptRun | null
  }
  projects: {
    getById(projectId: string): PlanReviewProject | undefined
  }
  sessions: {
    findById(sessionId: string): PlanReviewSession | undefined | null
    sessionPath(sessionId: string): string
  }
  renderer: {
    getActiveWindow(): BrowserWindow | null
    /** With no window open the review waits; the next window to load shows it. */
    waitForResponse(
      input: AgentUserInteractionInput,
      window: BrowserWindow | null,
      signals?: ReadonlyArray<AbortSignal | undefined>
    ): Promise<PlanReviewResponse>
  }
  timeline: {
    append(sessionId: string, event: PlanReviewEvent): StoredEvent
    broadcast(sessionId: string, event: StoredEvent): void
  }
  state: {
    createId(): string
    markNeedsInput(
      sessionId: string,
      requestId: string,
      input: { kind: 'plan_review'; message: string }
    ): void
    markInputCancelled(sessionId: string, requestId: string): void
    markInputAnswered(sessionId: string, requestId: string): void
    notifySessionChanged(): void
  }
}

interface ValidPlanReviewRequest {
  runtimeSessionId: string
  title: string
  content: string
  planFilePath: string
  steps?: PlanSpec
  replanRequestId?: string
}

interface PlanReviewTarget {
  run: PlanReviewPromptRun
  project: PlanReviewProject | undefined
  window: BrowserWindow | null
}

function readPlanSteps(value: unknown, projectRoot: string | undefined): PlanSpec | undefined {
  if (value === undefined) return undefined
  const validated = validatePlanSpec(value, projectRoot)
  if (!validated.ok) throw new Error('Invalid plan review request')
  return validated.spec
}

function readPlanReviewRequest<StoredEvent>(
  params: unknown,
  deps: PlanReviewRequestDeps<StoredEvent>
): ValidPlanReviewRequest {
  const record = isRecord(params) ? params : {}
  const runtimeSessionId = deps.fields.optionalStringField(record, 'runtimeSessionId')
  const title = deps.fields.optionalStringField(record, 'title')?.trim()
  const content = deps.fields.optionalStringField(record, 'planContent')
  const planFilePath = deps.fields.optionalStringField(record, 'planFilePath')
  const steps = readPlanSteps(
    record.steps,
    runtimeSessionId ? deps.runs.findByRuntimeSessionId(runtimeSessionId)?.cwd : undefined
  )
  const replanRequestId = deps.fields.optionalStringField(record, 'replanRequestId')
  if (
    !runtimeSessionId ||
    !title ||
    Array.from(title).length > 120 ||
    !content?.trim() ||
    Buffer.byteLength(content, 'utf8') > 64 * 1024 ||
    !planFilePath ||
    !/^local:\/\/[A-Za-z0-9_-]+\.md$/.test(planFilePath) ||
    (replanRequestId !== undefined && (replanRequestId.length > 200 || !steps))
  ) {
    throw new Error('Invalid plan review request')
  }
  return {
    runtimeSessionId,
    title,
    content,
    planFilePath,
    ...(steps ? { steps } : {}),
    ...(replanRequestId ? { replanRequestId } : {})
  }
}

function resolvePlanReviewTarget<StoredEvent>(
  request: ValidPlanReviewRequest,
  context: PhiHostRequestContext | undefined,
  deps: PlanReviewRequestDeps<StoredEvent>
): PlanReviewTarget {
  const run = deps.runs.findByRuntimeSessionId(request.runtimeSessionId)
  if (
    !run ||
    run.cancelled ||
    context?.originSessionId !== request.runtimeSessionId ||
    context.signal?.aborted
  ) {
    throw new Error('No active conversation for plan review')
  }
  const project = run.projectId ? deps.projects.getById(run.projectId) : undefined
  const manifest = deps.sessions.findById(run.phiSessionId)
  if (
    (project?.location.kind === 'ssh' || manifest?.projectLocation?.kind === 'ssh') &&
    context?.kernelOrigin !== true &&
    !(
      context?.remoteOriginAuthenticated === true &&
      context.remotePlanPhase === (request.steps ? 'plan_execute' : 'plan') &&
      (manifest?.workMode === context.remotePlanPhase || manifest?.workMode === 'auto') &&
      context.originSessionId === request.runtimeSessionId &&
      context.agentRunId === run.runId &&
      typeof context.toolCallId === 'string' &&
      context.toolCallId.length > 0
    )
  ) {
    throw new Error('远程项目暂不支持计划评审')
  }
  const window = deps.renderer.getActiveWindow()
  return { run, project, window }
}

function submitPlanReview<StoredEvent>(
  request: ValidPlanReviewRequest,
  target: PlanReviewTarget,
  reviewId: string,
  deps: PlanReviewRequestDeps<StoredEvent>
): void {
  const submitted = deps.timeline.append(target.run.phiSessionId, {
    type: 'plan_review_submitted',
    runId: target.run.runId,
    reviewId,
    title: request.title,
    content: request.content,
    planFilePath: request.planFilePath,
    ...(request.steps ? { steps: request.steps } : {})
  })
  deps.timeline.broadcast(target.run.phiSessionId, submitted)
  deps.state.markNeedsInput(target.run.phiSessionId, reviewId, {
    kind: 'plan_review',
    message: request.title
  })
  deps.state.notifySessionChanged()
}

function planReviewDecision(response: PlanReviewResponse): PlanReviewDecision {
  const answer = response.answers.find((item) => item.question === 'plan_review')?.answer
  if (response.cancelled) return 'cancel'
  return answer === 'approve' || answer === 'revise' ? answer : 'cancel'
}

function planReviewNote(response: PlanReviewResponse): string {
  return typeof response.globalNote === 'string' ? response.globalNote.trim().slice(0, 2000) : ''
}

function recordPlanReviewDecision<StoredEvent>(
  target: PlanReviewTarget,
  reviewId: string,
  outcome: {
    decision: PlanReviewDecision
    note: string
    reason?: PlanReviewDecidedEvent['reason']
  },
  deps: PlanReviewRequestDeps<StoredEvent>
): void {
  const { decision, note, reason } = outcome
  if (decision === 'cancel') {
    deps.state.markInputCancelled(target.run.phiSessionId, reviewId)
  } else {
    deps.state.markInputAnswered(target.run.phiSessionId, reviewId)
  }
  const decided = deps.timeline.append(target.run.phiSessionId, {
    type: 'plan_review_decided',
    runId: target.run.runId,
    reviewId,
    decision,
    ...(note && decision === 'revise' ? { note } : {}),
    ...(reason ? { reason } : {})
  })
  deps.timeline.broadcast(target.run.phiSessionId, decided)
  deps.state.notifySessionChanged()
}

function planReviewRunIsCurrent<StoredEvent>(
  request: ValidPlanReviewRequest,
  target: PlanReviewTarget,
  context: PhiHostRequestContext | undefined,
  deps: PlanReviewRequestDeps<StoredEvent>
): boolean {
  const current = deps.runs.findByRuntimeSessionId(request.runtimeSessionId)
  return Boolean(
    !context?.signal?.aborted &&
    current &&
    !current.cancelled &&
    current.phiSessionId === target.run.phiSessionId &&
    current.runId === target.run.runId &&
    current.sessionGeneration === target.run.sessionGeneration &&
    current.projectId === target.run.projectId &&
    current.cwd === target.run.cwd &&
    (context?.remoteOriginAuthenticated !== true ||
      (context.originSessionId === request.runtimeSessionId &&
        context.agentRunId === target.run.runId &&
        typeof context.toolCallId === 'string' &&
        context.toolCallId.length > 0))
  )
}

export function createPlanReviewRequest<StoredEvent>(
  deps: PlanReviewRequestDeps<StoredEvent>
): (
  params: unknown,
  context?: PhiHostRequestContext
) => Promise<{ decision: PlanReviewDecision; note?: string }> {
  return async function handlePlanReviewRequest(params, context) {
    const request = readPlanReviewRequest(params, deps)
    const target = resolvePlanReviewTarget(request, context, deps)
    if (!planReviewRunIsCurrent(request, target, context, deps)) {
      return { decision: 'cancel' }
    }
    const reviewId = deps.state.createId()
    submitPlanReview(request, target, reviewId, deps)
    const response = await deps.renderer.waitForResponse(
      {
        requestId: reviewId,
        questions: [],
        planReview: {
          title: request.title,
          content: request.content,
          planFilePath: request.planFilePath,
          ...(request.steps ? { steps: request.steps } : {})
        },
        sessionId: target.run.phiSessionId,
        sessionPath: deps.sessions.sessionPath(target.run.phiSessionId),
        sessionGeneration: target.run.sessionGeneration,
        runId: target.run.runId,
        cwd: target.run.cwd,
        ...(target.project?.name ? { projectName: target.project.name } : {})
      },
      target.window,
      [context?.signal]
    )
    const decision = planReviewDecision(response)
    const note = planReviewNote(response)
    if (!planReviewRunIsCurrent(request, target, context, deps)) {
      recordPlanReviewDecision(
        target,
        reviewId,
        { decision: 'cancel', note: '', reason: 'review_expired' },
        deps
      )
      return { decision: 'cancel' }
    }
    recordPlanReviewDecision(target, reviewId, { decision, note }, deps)
    return {
      decision,
      ...(note && decision === 'revise' ? { note } : {})
    }
  }
}
