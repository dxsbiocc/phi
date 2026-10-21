import type { PhiHostRequestContext } from '../engine/types'
import type {
  AgentUserInteractionQuestion,
  AgentUserInteractionRequest,
  AgentUserInteractionResponse
} from '../../../shared/agentInteractionTypes'
import { isRecord } from '../../../shared/guards'

export interface AgentInteractionPromptRun {
  phiSessionId: string
  runId: string
  cwd: string
  projectId?: string
  sessionGeneration: number
  cancelled: boolean
}

interface AgentInteractionProject {
  name?: string
  location: {
    kind: string
    remoteRoot?: string
  }
}

interface PendingInputState {
  kind: 'ask_user_question'
  message: string
}

export interface AgentInteractionRequestDeps<Window = unknown> {
  fields: {
    optionalStringField(record: Record<string, unknown>, key: string): string | undefined
  }
  runs: {
    findByRuntimeSessionId(runtimeSessionId: string): AgentInteractionPromptRun | null
  }
  projects: {
    getById(projectId: string): AgentInteractionProject | undefined
    getByCwd(cwd: string): AgentInteractionProject | undefined
  }
  renderer: {
    getActiveWindow(): Window | null
    canRequest(window: Window | null): boolean
    waitForResponse(
      request: AgentUserInteractionRequest,
      window: Window,
      signals: ReadonlyArray<AbortSignal | undefined>
    ): Promise<AgentUserInteractionResponse>
  }
  state: {
    createId(): string
    sessionPath(sessionId: string): string
    markNeedsInput(sessionId: string, interactionId: string, state: PendingInputState): void
    markInputCancelled(sessionId: string, interactionId: string): void
    markInputAnswered(sessionId: string, interactionId: string): void
    notifySessionChanged(): void
  }
}

interface ParsedInteractionRequest {
  runtimeSessionId: string
  questions: AgentUserInteractionQuestion[]
}

function interactionOptionsField<Window>(
  value: unknown,
  deps: AgentInteractionRequestDeps<Window>
): AgentUserInteractionQuestion['options'] | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value
    .filter(isRecord)
    .map((item) => {
      const label = deps.fields.optionalStringField(item, 'label')
      const description = deps.fields.optionalStringField(item, 'description')
      if (!label || !description) return null
      return {
        label,
        description,
        ...(deps.fields.optionalStringField(item, 'preview')
          ? { preview: deps.fields.optionalStringField(item, 'preview') }
          : {})
      }
    })
    .filter((item): item is AgentUserInteractionQuestion['options'][number] => item !== null)
  return options.length > 0 ? options : undefined
}

function interactionQuestionsField<Window>(
  value: unknown,
  deps: AgentInteractionRequestDeps<Window>
): AgentUserInteractionQuestion[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((item) => {
      const question = deps.fields.optionalStringField(item, 'question')
      const header = deps.fields.optionalStringField(item, 'header')
      const options = interactionOptionsField(item.options, deps)
      if (!question || !header || !options) return null
      return {
        question,
        header,
        options,
        ...(item.multiSelect === true ? { multiSelect: true } : {})
      }
    })
    .filter((item): item is AgentUserInteractionQuestion => item !== null)
}

function parseInteractionRequest<Window>(
  params: unknown,
  deps: AgentInteractionRequestDeps<Window>
): ParsedInteractionRequest {
  const record = isRecord(params) ? params : {}
  const runtimeSessionId = deps.fields.optionalStringField(record, 'runtimeSessionId')
  const questions = interactionQuestionsField(record.questions, deps)
  if (!runtimeSessionId || questions.length === 0) {
    throw new Error('Invalid user interaction request')
  }
  return { runtimeSessionId, questions }
}

function activeInteractionRun<Window>(
  runtimeSessionId: string,
  context: PhiHostRequestContext | undefined,
  deps: AgentInteractionRequestDeps<Window>
): AgentInteractionPromptRun {
  const run = deps.runs.findByRuntimeSessionId(runtimeSessionId)
  if (
    !run ||
    run.cancelled ||
    (context?.originSessionId && context.originSessionId !== runtimeSessionId)
  ) {
    throw new Error('No active run for user interaction request')
  }
  return run
}

function interactionRequest(
  interactionId: string,
  questions: AgentUserInteractionQuestion[],
  run: AgentInteractionPromptRun,
  project: AgentInteractionProject | undefined,
  sessionPath: string
): AgentUserInteractionRequest {
  return {
    requestId: interactionId,
    questions,
    sessionId: run.phiSessionId,
    sessionPath,
    sessionGeneration: run.sessionGeneration,
    runId: run.runId,
    cwd: project?.location.kind === 'ssh' ? project.location.remoteRoot : run.cwd,
    ...(project?.name ? { projectName: project.name } : {})
  }
}

function interactionBecameStale<Window>(
  runtimeSessionId: string,
  run: AgentInteractionPromptRun,
  context: PhiHostRequestContext | undefined,
  deps: AgentInteractionRequestDeps<Window>
): boolean {
  return Boolean(
    context?.signal?.aborted ||
    run.cancelled ||
    deps.runs.findByRuntimeSessionId(runtimeSessionId) !== run
  )
}

function recordInteractionResponse<Window>(
  run: AgentInteractionPromptRun,
  interactionId: string,
  response: AgentUserInteractionResponse,
  deps: AgentInteractionRequestDeps<Window>
): void {
  if (response.cancelled) {
    deps.state.markInputCancelled(run.phiSessionId, interactionId)
  } else {
    deps.state.markInputAnswered(run.phiSessionId, interactionId)
  }
  deps.state.notifySessionChanged()
}

export function createAgentInteractionRequest<Window = unknown>(
  deps: AgentInteractionRequestDeps<Window>
): (params: unknown, context?: PhiHostRequestContext) => Promise<unknown> {
  return async function handleAgentInteractionRequest(
    params: unknown,
    context?: PhiHostRequestContext
  ): Promise<unknown> {
    const { runtimeSessionId, questions } = parseInteractionRequest(params, deps)
    const run = activeInteractionRun(runtimeSessionId, context, deps)
    const window = deps.renderer.getActiveWindow()
    if (!deps.renderer.canRequest(window)) {
      throw new Error('没有可用窗口来请求用户输入')
    }

    const interactionId = deps.state.createId()
    const project = run.projectId
      ? deps.projects.getById(run.projectId)
      : deps.projects.getByCwd(run.cwd)
    deps.state.markNeedsInput(run.phiSessionId, interactionId, {
      kind: 'ask_user_question',
      message: questions[0].question
    })
    const response = await deps.renderer.waitForResponse(
      interactionRequest(
        interactionId,
        questions,
        run,
        project,
        deps.state.sessionPath(run.phiSessionId)
      ),
      window as Window,
      [context?.signal]
    )
    if (interactionBecameStale(runtimeSessionId, run, context, deps)) {
      deps.state.markInputCancelled(run.phiSessionId, interactionId)
      deps.state.notifySessionChanged()
      return { requestId: interactionId, answers: [], cancelled: true }
    }
    recordInteractionResponse(run, interactionId, response, deps)
    return response
  }
}
