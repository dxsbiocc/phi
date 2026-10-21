import type {
  CreateAgentSessionResult,
  RuntimeAgentSession
} from '../agent/runtime/runtime-adapter'
import type { PromptRunResult } from '../agent/session/prompt-run-execution'
import type { SessionEventInput } from '../agent/session/session-store'
import type { PromptImageInput, StoredPromptImage } from '../../shared/promptImageTypes'
import type { AdmittedPromptRun } from './prompt-run-admission'

export interface PromptRunState {
  sessionKey: string
  phiSessionId: string
  runId: string
  cwd: string
  projectId?: string
  generation: number
  sessionGeneration: number
  cancelled: boolean
  recordedFailureMessage?: string
  stoppingPermanentProviderError?: boolean
  thinkingBlocks: Map<number, string>
  thinkingBlockStartedAtMs: Map<number, number>
  compactionReasons: Map<string, string>
  agentToolCallIds: Set<string>
  sdkToolCallIds: Set<string>
  browserSdkToolCallIds: Set<string>
  persistedToolCallIds: Set<string>
  pendingProviderToolCalls: Map<string, { toolName: string; args: unknown; createdAt?: string }>
  sessionPath?: string | null
  session?: RuntimeAgentSession
  done?: Promise<PromptRunResult>
}

export interface PromptRunContext extends AdmittedPromptRun<CreateAgentSessionResult> {
  runGeneration: number
  storedImages: StoredPromptImage[]
  otherActiveProjectRuns: number
  promptRun: PromptRunState
}

export interface PromptRunStartDeps {
  runs: {
    advanceGeneration(sessionKey: string): number
    setActiveRun(sessionKey: string, run: PromptRunState): void
    activeRuns(): PromptRunState[]
  }
  continuations: {
    delete(phiSessionId: string): void
  }
  images: {
    persist(phiSessionId: string, images: readonly PromptImageInput[]): StoredPromptImage[]
  }
  events: {
    append(phiSessionId: string, event: SessionEventInput): unknown
  }
  cleanup: {
    deleteActiveRun(sessionKey: string, run: PromptRunState): void
  }
  notify: {
    parallelRun(
      sessionGeneration: number,
      sessionPath: string | undefined,
      cwd: string,
      activeCount: number
    ): void
  }
}

function allocatePromptRun(
  deps: PromptRunStartDeps,
  admission: AdmittedPromptRun<CreateAgentSessionResult>
): PromptRunContext {
  const runGeneration = deps.runs.advanceGeneration(admission.runSessionKey)
  // A real user message starts the automatic wake-up count over only after preflight succeeds.
  if (!admission.input.automatic) deps.continuations.delete(admission.phiSessionId)
  const storedImages = admission.input.images?.length
    ? deps.images.persist(admission.phiSessionId, admission.input.images)
    : []
  const projectId = admission.project?.id
  const otherActiveProjectRuns = projectId
    ? deps.runs
        .activeRuns()
        .filter((run) => run.projectId === projectId && run.sessionKey !== admission.runSessionKey)
        .length
    : 0
  const promptRun: PromptRunState = {
    sessionKey: admission.runSessionKey,
    phiSessionId: admission.phiSessionId,
    runId: admission.runId,
    cwd: admission.runSnapshot.cwd,
    ...(projectId ? { projectId } : {}),
    generation: runGeneration,
    sessionGeneration: admission.runSessionGeneration,
    cancelled: false,
    thinkingBlocks: new Map(),
    thinkingBlockStartedAtMs: new Map(),
    compactionReasons: new Map(),
    agentToolCallIds: new Set(),
    sdkToolCallIds: new Set(),
    browserSdkToolCallIds: new Set(),
    persistedToolCallIds: new Set(),
    pendingProviderToolCalls: new Map(),
    sessionPath: admission.stableSessionPath
  }
  deps.runs.setActiveRun(admission.runSessionKey, promptRun)
  return { ...admission, runGeneration, storedImages, otherActiveProjectRuns, promptRun }
}

function preparePromptRunForQueue(deps: PromptRunStartDeps, context: PromptRunContext): void {
  const { input, phiSessionId, runId, normalizedText, promptTarget, storedImages, promptRun } =
    context
  try {
    if (input.automatic) {
      // Phi's own message to the agent, not the user's words: nothing to show as a user bubble.
    } else if (promptTarget?.suppressUserMessageEvent === true) {
      deps.events.append(phiSessionId, {
        type: 'user_message_retry',
        runId,
        content: normalizedText,
        ...(storedImages.length ? { images: storedImages } : {}),
        ...(promptTarget.retryUserMessageId
          ? { userMessageId: promptTarget.retryUserMessageId }
          : {})
      })
    } else {
      deps.events.append(phiSessionId, {
        type: 'user_message',
        runId,
        content: normalizedText,
        ...(storedImages.length ? { images: storedImages } : {})
      })
    }
  } catch (error) {
    deps.cleanup.deleteActiveRun(context.runSessionKey, promptRun)
    throw error
  }
  if (context.otherActiveProjectRuns > 0 && !input.automatic) {
    deps.notify.parallelRun(
      context.runSessionGeneration,
      context.stableSessionPath,
      context.runSnapshot.cwd,
      context.otherActiveProjectRuns
    )
  }
}

export interface PromptRunStart {
  allocate(admission: AdmittedPromptRun<CreateAgentSessionResult>): PromptRunContext
  prepare(context: PromptRunContext): void
}

export function createPromptRunStart(deps: PromptRunStartDeps): PromptRunStart {
  return {
    allocate: (admission) => allocatePromptRun(deps, admission),
    prepare: (context) => preparePromptRunForQueue(deps, context)
  }
}
