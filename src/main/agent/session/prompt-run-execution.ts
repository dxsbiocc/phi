import { getAuthManager } from '../auth-manager'
import { getPhiEngine, ownsRemoteRuntimeSession } from '../engine/in-process-engine'
import { redactSensitiveText } from '../redaction'
import type { ModelRuntime, RuntimeAgentSession, RuntimeModel } from '../runtime/runtime-adapter'
import { promptWithAutomaticModelFallback } from './automatic-model-fallback'
import { isStaleSessionError, StaleSessionError, type SessionSnapshot } from './session-lifecycle'
import { appendSessionEvent, type StoredSessionEvent } from './session-store'

export type PromptRunResult = {
  path: string | null
  phiSessionId?: string
  sessionGeneration: number
} | null

export interface PromptRunExecutionState {
  runId: string
  generation: number
  sessionGeneration: number
  cancelled: boolean
  recordedFailureMessage?: string
  stoppingPermanentProviderError?: boolean
  sessionPath?: string | null
  session?: RuntimeAgentSession
}

export interface PromptRunExecutionContext {
  input: {
    images?: Array<{ data: string; mimeType: string }>
    planMode?: boolean
    planExecute?: boolean
  }
  normalizedText: string
  runSessionKey: string
  runLifecycle: { isCurrentGeneration(generation: number): boolean }
  runSnapshot: SessionSnapshot
  automaticModelSelection: boolean
  phiSessionId: string
  stableSessionPath: string
  runId: string
  promptRun: PromptRunExecutionState
}

export interface PromptRunExecutionDeps<TContext extends PromptRunExecutionContext> {
  lifecycle: {
    getPromptGeneration(sessionKey: string): number
  }
  session: {
    getAgentSession(
      sessionKey: string,
      snapshot: SessionSnapshot
    ): Promise<{ session: RuntimeAgentSession }>
    applyNextRunConfiguration(
      session: RuntimeAgentSession,
      sessionKey: string,
      snapshot: SessionSnapshot
    ): Promise<void>
    abortSession(session: RuntimeAgentSession): Promise<void>
    abortSessionWithoutCancellingApprovals(session: RuntimeAgentSession): Promise<void>
    linkRuntimeSessionPath(context: TContext, session: RuntimeAgentSession): void
    recordMaterialization(context: TContext): void
  }
  models: {
    selectableRuntimeModels(runtime: ModelRuntime): RuntimeModel[]
  }
  timeline: {
    broadcastSessionTimelineEvent(phiSessionId: string, event: StoredSessionEvent): void
    logUnexpectedError(error: unknown): void
  }
}

interface PromptRunExecution<TContext extends PromptRunExecutionContext> {
  context: TContext
  deps: PromptRunExecutionDeps<TContext>
  signal: AbortSignal
  session: RuntimeAgentSession
  automatic: boolean
  automaticCandidates: () => Promise<RuntimeModel[]>
  setPromptResult: (result: PromptRunResult) => void
}

function promptRunFallbackInput<TContext extends PromptRunExecutionContext>(
  execution: PromptRunExecution<TContext>
): Parameters<typeof promptWithAutomaticModelFallback>[0] {
  const { context, deps, signal, session, automatic, automaticCandidates } = execution
  return {
    session,
    text: context.normalizedText,
    automatic,
    isCurrent: () =>
      !signal.aborted &&
      !context.promptRun.cancelled &&
      context.promptRun.generation === deps.lifecycle.getPromptGeneration(context.runSessionKey) &&
      context.runLifecycle.isCurrentGeneration(context.promptRun.sessionGeneration),
    recordedFailure: () => context.promptRun.recordedFailureMessage,
    clearFailure: () => {
      delete context.promptRun.recordedFailureMessage
      delete context.promptRun.stoppingPermanentProviderError
    },
    candidates: automaticCandidates,
    onSwitch: (from, to, error) => {
      const stored = appendSessionEvent(context.phiSessionId, {
        type: 'model_fallback',
        runId: context.runId,
        fromProviderId: from.provider,
        fromModelId: from.id,
        toProviderId: to.provider,
        toModelId: to.id,
        toModelName: to.name,
        errorMessage: redactSensitiveText(error)
      })
      deps.timeline.broadcastSessionTimelineEvent(context.phiSessionId, stored)
    },
    options: {
      hostRunId: context.promptRun.runId,
      ...(context.input.images?.length
        ? {
            images: context.input.images.map((image) => ({
              type: 'image' as const,
              data: image.data,
              mimeType: image.mimeType
            }))
          }
        : {}),
      preflightResult: (success) => {
        if (
          success &&
          (signal.aborted ||
            context.promptRun.cancelled ||
            context.promptRun.generation !==
              deps.lifecycle.getPromptGeneration(context.runSessionKey) ||
            !context.runLifecycle.isCurrentGeneration(context.promptRun.sessionGeneration))
        ) {
          void deps.session.abortSessionWithoutCancellingApprovals(session).catch((error) => {
            deps.timeline.logUnexpectedError(error)
            console.error('Failed to abort stale prompt:', error)
          })
          throw new StaleSessionError()
        }
      }
    }
  }
}

function recordPromptRunMaterialization<TContext extends PromptRunExecutionContext>(
  execution: PromptRunExecution<TContext>
): void {
  const { context, deps, setPromptResult } = execution
  // A brand-new chat's first prompt is when it actually becomes a file on disk —
  // hand the stable Phi path back so the renderer can refresh and highlight it.
  deps.session.recordMaterialization(context)
  context.promptRun.sessionPath = context.stableSessionPath
  setPromptResult({
    path: context.stableSessionPath,
    phiSessionId: context.phiSessionId,
    sessionGeneration: context.promptRun.sessionGeneration
  })
}

async function promptAgentForRun<TContext extends PromptRunExecutionContext>(
  execution: PromptRunExecution<TContext>
): Promise<void> {
  const { context, deps, signal, session } = execution
  try {
    await promptWithAutomaticModelFallback(promptRunFallbackInput(execution))
  } catch (error) {
    deps.session.linkRuntimeSessionPath(context, session)
    if (
      signal.aborted ||
      context.promptRun.cancelled ||
      context.promptRun.generation !== deps.lifecycle.getPromptGeneration(context.runSessionKey) ||
      !context.runLifecycle.isCurrentGeneration(context.promptRun.sessionGeneration)
    ) {
      return
    }
    throw error
  }
  deps.session.linkRuntimeSessionPath(context, session)

  if (
    signal.aborted ||
    context.promptRun.cancelled ||
    context.promptRun.generation !== deps.lifecycle.getPromptGeneration(context.runSessionKey) ||
    !context.runLifecycle.isCurrentGeneration(context.promptRun.sessionGeneration)
  ) {
    return
  }
  recordPromptRunMaterialization(execution)
}

function needsAutomaticPromptImageModel<TContext extends PromptRunExecutionContext>(
  execution: PromptRunExecution<TContext>
): boolean {
  return Boolean(
    execution.automatic &&
    execution.context.input.images?.length &&
    execution.session.model?.supportsImages !== true
  )
}

function promptImagesAreUnsupported<TContext extends PromptRunExecutionContext>(
  execution: PromptRunExecution<TContext>
): boolean {
  return Boolean(
    execution.context.input.images?.length && execution.session.model?.supportsImages !== true
  )
}

async function configurePromptRunSession<TContext extends PromptRunExecutionContext>(
  execution: PromptRunExecution<TContext>
): Promise<void> {
  const { context, deps, signal, session, automaticCandidates } = execution
  await deps.session.applyNextRunConfiguration(session, context.runSessionKey, context.runSnapshot)
  if (context.input.planMode || context.input.planExecute) {
    await getPhiEngine().sessions.enterPlanMode({
      sessionId: session.runtimeSessionId,
      ...(context.input.planExecute ? { execute: true } : {})
    })
  }
  if (needsAutomaticPromptImageModel(execution)) {
    const compatible = (await automaticCandidates())[0]
    if (signal.aborted || context.promptRun.cancelled) return
    if (compatible) await session.setModel(compatible)
  }
  if (promptImagesAreUnsupported(execution)) {
    throw new Error('当前模型不支持图片，请切换到支持图片的模型后重试')
  }

  if (
    signal.aborted ||
    context.promptRun.cancelled ||
    context.promptRun.generation !== deps.lifecycle.getPromptGeneration(context.runSessionKey) ||
    !context.runLifecycle.isCurrentGeneration(context.promptRun.sessionGeneration)
  ) {
    await deps.session.abortSession(session)
    return
  }
  return promptAgentForRun(execution)
}

export async function executePromptRun<TContext extends PromptRunExecutionContext>(
  context: TContext,
  deps: PromptRunExecutionDeps<TContext>,
  signal: AbortSignal,
  setPromptResult: (result: PromptRunResult) => void
): Promise<void> {
  if (signal.aborted || context.promptRun.cancelled) return

  let session: RuntimeAgentSession
  try {
    const result = await deps.session.getAgentSession(context.runSessionKey, context.runSnapshot)
    session = result.session
  } catch (error) {
    if (
      isStaleSessionError(error) ||
      context.promptRun.cancelled ||
      signal.aborted ||
      !context.runLifecycle.isCurrentGeneration(context.promptRun.sessionGeneration)
    ) {
      return
    }
    throw error
  }
  context.promptRun.session = session
  const automatic =
    context.automaticModelSelection && !ownsRemoteRuntimeSession(session.runtimeSessionId)
  const automaticCandidates = async (): Promise<RuntimeModel[]> => {
    const [runtime, providers] = await Promise.all([
      getAuthManager().getRuntime(),
      getAuthManager().getProviderStatuses()
    ])
    const configured = new Set(
      providers.filter((provider) => provider.configured).map((provider) => provider.providerId)
    )
    return deps.models
      .selectableRuntimeModels(runtime)
      .filter(
        (model) =>
          configured.has(model.provider) &&
          (!context.input.images?.length || model.supportsImages === true)
      )
  }
  return configurePromptRunSession({
    context,
    deps,
    signal,
    session,
    automatic,
    automaticCandidates,
    setPromptResult
  })
}
