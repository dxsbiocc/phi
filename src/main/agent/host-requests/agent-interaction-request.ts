import type { PhiHostRequestContext } from '../engine/types'
import type {
  AgentUserInteractionQuestion,
  AgentUserInteractionRequest,
  AgentUserInteractionResponse,
  MissingToolCandidateSource,
  MissingToolId,
  MissingToolPrompt,
  MissingToolRejectReason
} from '../../../shared/agentInteractionTypes'
import { isRecord } from '../../../shared/guards'

export interface AgentInteractionPromptRun {
  phiSessionId: string
  runId: string
  cwd: string
  projectId?: string
  sessionGeneration: number
  cancelled: boolean
  /**
   * A host-origin run owned by a live conversation but not by an active prompt
   * run (plan execution starts steps after the prompt turn settles). It is
   * resolved from the runtime-session origin rather than the prompt registry.
   */
  detached?: boolean
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
    /** Plan steps and other host-origin runs that outlive their prompt turn. */
    findDetachedByRuntimeSessionId?(runtimeSessionId: string): AgentInteractionPromptRun | null
  }
  projects: {
    getById(projectId: string): AgentInteractionProject | undefined
    getByCwd(cwd: string): AgentInteractionProject | undefined
  }
  renderer: {
    getActiveWindow(): Window | null
    /** With no window open the request waits; the next window to load shows it. */
    waitForResponse(
      request: AgentUserInteractionRequest,
      window: Window | null,
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
  missingTool?: MissingToolPrompt
}

const missingToolIds = new Set<MissingToolId>([
  'nextflow',
  'java',
  'jupyter',
  'docker',
  'singularity',
  'apptainer',
  'podman'
])
const missingToolSources = new Set<MissingToolCandidateSource>([
  'saved',
  'path',
  'conda',
  'micromamba',
  'phi',
  'common'
])

// The bounded parser checks every renderer-facing field before the request crosses IPC.
// eslint-disable-next-line complexity
function missingToolField<Window>(
  value: unknown,
  runtimeSessionId: string,
  deps: AgentInteractionRequestDeps<Window>
): MissingToolPrompt | undefined {
  if (!isRecord(value) || value.runtimeSessionId !== runtimeSessionId || !isRecord(value.tool)) {
    return undefined
  }
  const id = value.tool.id
  const label = deps.fields.optionalStringField(value.tool, 'label')
  if (typeof id !== 'string' || !missingToolIds.has(id as MissingToolId) || !label) return undefined
  if (!Array.isArray(value.candidates) || value.candidates.length > 32) return undefined
  const candidates = value.candidates.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const path = deps.fields.optionalStringField(candidate, 'path')
    const source = candidate.source
    const version = deps.fields.optionalStringField(candidate, 'version')
    if (
      !path?.startsWith('/') ||
      /[\0\r\n]/.test(path) ||
      typeof source !== 'string' ||
      !missingToolSources.has(source as MissingToolCandidateSource)
    ) {
      return []
    }
    return [{ path, source: source as MissingToolCandidateSource, ...(version ? { version } : {}) }]
  })
  let install: MissingToolPrompt['install']
  if (isRecord(value.install)) {
    const environment = deps.fields.optionalStringField(value.install, 'environment')
    const location = deps.fields.optionalStringField(value.install, 'location')
    const approximateSize = deps.fields.optionalStringField(value.install, 'approximateSize')
    const packages = Array.isArray(value.install.packages)
      ? value.install.packages.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        )
      : []
    if (
      environment &&
      location &&
      approximateSize &&
      packages.length > 0 &&
      packages.length <= 20
    ) {
      install = { environment, location, approximateSize, packages }
    }
  }
  const rejectedPath = rejectedPathField(value.rejectedPath, deps)
  return {
    runtimeSessionId,
    tool: { id: id as MissingToolId, label },
    candidates,
    ...(install ? { install } : {}),
    ...(rejectedPath ? { rejectedPath } : {})
  }
}

const rejectReasons = new Set<MissingToolRejectReason>([
  'path-must-be-absolute',
  'invalid-path',
  'not-executable',
  'host-check-failed',
  'no-version',
  'java-too-old'
])

function rejectedPathField<Window>(
  value: unknown,
  deps: AgentInteractionRequestDeps<Window>
): MissingToolPrompt['rejectedPath'] {
  if (!isRecord(value)) return undefined
  const path = deps.fields.optionalStringField(value, 'path')
  const reason = value.reason
  if (!path || path.length > 4_096 || /[\0\r\n]/.test(path)) return undefined
  if (typeof reason !== 'string' || !rejectReasons.has(reason as MissingToolRejectReason))
    return undefined
  return { path, reason: reason as MissingToolRejectReason }
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
  const missingTool = missingToolField(record.missingTool, runtimeSessionId, deps)
  if (record.missingTool !== undefined && !missingTool) {
    throw new Error('Invalid missing tool interaction request')
  }
  return { runtimeSessionId, questions, ...(missingTool ? { missingTool } : {}) }
}

function activeInteractionRun<Window>(
  runtimeSessionId: string,
  context: PhiHostRequestContext | undefined,
  deps: AgentInteractionRequestDeps<Window>
): AgentInteractionPromptRun {
  const run =
    deps.runs.findByRuntimeSessionId(runtimeSessionId) ??
    deps.runs.findDetachedByRuntimeSessionId?.(runtimeSessionId) ??
    null
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
  details: {
    project: AgentInteractionProject | undefined
    sessionPath: string
    missingTool?: MissingToolPrompt
  }
): AgentUserInteractionRequest {
  const { project, sessionPath, missingTool } = details
  return {
    requestId: interactionId,
    questions,
    sessionId: run.phiSessionId,
    sessionPath,
    sessionGeneration: run.sessionGeneration,
    runId: run.runId,
    cwd: project?.location.kind === 'ssh' ? project.location.remoteRoot : run.cwd,
    ...(project?.name ? { projectName: project.name } : {}),
    ...(missingTool ? { missingTool } : {})
  }
}

function interactionBecameStale<Window>(
  runtimeSessionId: string,
  run: AgentInteractionPromptRun,
  context: PhiHostRequestContext | undefined,
  deps: AgentInteractionRequestDeps<Window>
): boolean {
  if (context?.signal?.aborted || run.cancelled) return true
  // A detached host run has no prompt-registry entry to be replaced. Its
  // cancellation signal and run state are the lifecycle it was resolved from.
  if (run.detached) return false
  return deps.runs.findByRuntimeSessionId(runtimeSessionId) !== run
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
    const { runtimeSessionId, questions, missingTool } = parseInteractionRequest(params, deps)
    const run = activeInteractionRun(runtimeSessionId, context, deps)
    const window = deps.renderer.getActiveWindow()

    const interactionId = deps.state.createId()
    const project = run.projectId
      ? deps.projects.getById(run.projectId)
      : deps.projects.getByCwd(run.cwd)
    deps.state.markNeedsInput(run.phiSessionId, interactionId, {
      kind: 'ask_user_question',
      message: questions[0].question
    })
    const response = await deps.renderer.waitForResponse(
      interactionRequest(interactionId, questions, run, {
        project,
        sessionPath: deps.state.sessionPath(run.phiSessionId),
        missingTool
      }),
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
