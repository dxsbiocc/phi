import type { BrowserWindow } from 'electron'

import type { AgentUserInteractionInput, waitForAgentUserInteraction } from '../user-interaction'
import { isRecord } from '../../../shared/guards'

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
}

interface PlanReviewSubmittedEvent extends Record<string, unknown> {
  type: 'plan_review_submitted'
  runId: string
  reviewId: string
  title: string
  content: string
  planFilePath: string
}

interface PlanReviewDecidedEvent extends Record<string, unknown> {
  type: 'plan_review_decided'
  runId: string
  reviewId: string
  decision: PlanReviewDecision
  note?: string
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
    canRequest(window: BrowserWindow | null): window is BrowserWindow
    waitForResponse(
      input: AgentUserInteractionInput,
      window: BrowserWindow
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
}

interface PlanReviewTarget {
  run: PlanReviewPromptRun
  project: PlanReviewProject | undefined
  window: BrowserWindow
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
  if (
    !runtimeSessionId ||
    !title ||
    title.length > 120 ||
    !content?.trim() ||
    Buffer.byteLength(content, 'utf8') > 64 * 1024 ||
    !planFilePath ||
    !/^local:\/\/[A-Za-z0-9_-]+\.md$/.test(planFilePath)
  ) {
    throw new Error('Invalid plan review request')
  }
  return { runtimeSessionId, title, content, planFilePath }
}

function resolvePlanReviewTarget<StoredEvent>(
  request: ValidPlanReviewRequest,
  deps: PlanReviewRequestDeps<StoredEvent>
): PlanReviewTarget {
  const run = deps.runs.findByRuntimeSessionId(request.runtimeSessionId)
  if (!run || run.cancelled) throw new Error('No active conversation for plan review')
  const project = run.projectId ? deps.projects.getById(run.projectId) : undefined
  const manifest = deps.sessions.findById(run.phiSessionId)
  if (project?.location.kind === 'ssh' || manifest?.projectLocation?.kind === 'ssh') {
    throw new Error('远程项目暂不支持计划评审')
  }
  const window = deps.renderer.getActiveWindow()
  if (!deps.renderer.canRequest(window)) throw new Error('没有可用窗口来评审计划')
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
    planFilePath: request.planFilePath
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
  decision: PlanReviewDecision,
  note: string,
  deps: PlanReviewRequestDeps<StoredEvent>
): void {
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
    ...(note && decision === 'revise' ? { note } : {})
  })
  deps.timeline.broadcast(target.run.phiSessionId, decided)
  deps.state.notifySessionChanged()
}

export function createPlanReviewRequest<StoredEvent>(
  deps: PlanReviewRequestDeps<StoredEvent>
): (params: unknown) => Promise<{ decision: PlanReviewDecision; note?: string }> {
  return async function handlePlanReviewRequest(params) {
    const request = readPlanReviewRequest(params, deps)
    const target = resolvePlanReviewTarget(request, deps)
    const reviewId = deps.state.createId()
    submitPlanReview(request, target, reviewId, deps)
    const response = await deps.renderer.waitForResponse(
      {
        requestId: reviewId,
        questions: [],
        planReview: {
          title: request.title,
          content: request.content,
          planFilePath: request.planFilePath
        },
        sessionId: target.run.phiSessionId,
        sessionPath: deps.sessions.sessionPath(target.run.phiSessionId),
        sessionGeneration: target.run.sessionGeneration,
        runId: target.run.runId,
        cwd: target.run.cwd,
        ...(target.project?.name ? { projectName: target.project.name } : {})
      },
      target.window
    )
    const decision = planReviewDecision(response)
    const note = planReviewNote(response)
    recordPlanReviewDecision(target, reviewId, decision, note, deps)
    return { decision, ...(note && decision === 'revise' ? { note } : {}) }
  }
}
