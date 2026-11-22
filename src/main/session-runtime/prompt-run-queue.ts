import type { CreateAgentSessionResult } from '../agent/runtime/runtime-adapter'
import type { PromptRunResult } from '../agent/session/prompt-run-execution'
import type { StartSessionRunInput } from '../agent/session/session-runner-registry'
import type { SessionEventInput, StoredSessionEvent } from '../agent/session/session-store'
import {
  beginWorkspaceChangeCapture,
  finishWorkspaceChangeCapture
} from '../agent/session/workspace-changes'
import { persistWorkspaceDiff } from '../agent/session/workspace-diffs'
import type { WorkspaceChangeSummary } from '../../shared/workspaceChangeTypes'
import type {
  AdmittedPromptRun,
  ResolvedPromptRunTarget,
  SubmitPromptInput
} from './prompt-run-admission'
import type { PromptRunContext, PromptRunState } from './prompt-run-start'

const MAX_RUN_DIFF_BYTES = 2 * 1024 * 1024

interface QueuedSkill {
  name: string
  enabled: boolean
}

export interface PromptRunQueueDeps {
  admission: {
    resolve(input: SubmitPromptInput): ResolvedPromptRunTarget<CreateAgentSessionResult>
    admit(
      target: ResolvedPromptRunTarget<CreateAgentSessionResult>,
      existingRunId?: string
    ): AdmittedPromptRun<CreateAgentSessionResult>
  }
  start: {
    allocate(admission: AdmittedPromptRun<CreateAgentSessionResult>): PromptRunContext
    allocateFollowUp(
      admission: AdmittedPromptRun<CreateAgentSessionResult>,
      promptRun: PromptRunState
    ): PromptRunContext
    prepare(context: PromptRunContext): void
    prepareFollowUp(context: PromptRunContext): void
  }
  runs: {
    activeRun(sessionKey: string): PromptRunState | undefined
    queueFor(sessionKey: string): Promise<void>
    generationFor(sessionKey: string): number
    setQueue(sessionKey: string, queue: Promise<void>): void
    /** Registers a prompt before admission so stop can cancel it while invalidation replays. */
    beginSubmission(sessionKey: string): { cancelled: boolean }
    endSubmission(sessionKey: string, submission: { cancelled: boolean }): void
  }
  execution: {
    runner: {
      startRun(input: StartSessionRunInput): { done: Promise<void> }
    }
    execute(
      context: PromptRunContext,
      signal: AbortSignal,
      setResult: (result: PromptRunResult) => void
    ): Promise<void>
  }
  skills: {
    get(phiSessionId: string): string[] | undefined
    set(phiSessionId: string, names: string[]): void
    resolve(cwd: string): Promise<QueuedSkill[]>
  }
  timeline: {
    append(phiSessionId: string, event: SessionEventInput): StoredSessionEvent
    broadcast(phiSessionId: string, event: StoredSessionEvent): void
    logUnexpected(error: unknown): void
    logSkillLookupFailure(phiSessionId: string, error: unknown): void
  }
  invalidation: {
    /** Replays a deferred resource invalidation before this prompt acquires its session. */
    flushPending(sessionKey: string): Promise<void> | void
  }
  events: {
    automaticPromptStarted?(phiSessionId: string): void
    notifySessionChanged(): void
    flushContinuations(phiSessionId: string, cancelled: boolean): void
    scheduleTitle(phiSessionId: string): void
  }
  cleanup: {
    deleteActiveRun(sessionKey: string, run: PromptRunState): void
  }
  sleep: {
    sync(): void
  }
}

function persistWorkspaceChanges(
  deps: PromptRunQueueDeps,
  context: PromptRunContext,
  changes: WorkspaceChangeSummary | null
): void {
  if (changes && (changes.files.length > 0 || changes.truncated)) {
    try {
      const stored = deps.timeline.append(context.phiSessionId, {
        type: 'workspace_changes',
        runId: context.runId,
        ...changes
      })
      deps.timeline.broadcast(context.phiSessionId, stored)
    } catch (error) {
      deps.timeline.logUnexpected(error)
    }
  }
}

async function runQueuedPrompt(
  deps: PromptRunQueueDeps,
  context: PromptRunContext
): Promise<PromptRunResult> {
  let promptResult: PromptRunResult = null
  if (
    context.promptRun.cancelled ||
    context.promptRun.generation !== deps.runs.generationFor(context.runSessionKey) ||
    !context.runLifecycle.isCurrentGeneration(context.promptRun.sessionGeneration)
  ) {
    if (context.promptRun.cancelled) context.input.onCancelledBeforeStart?.()
    return null
  }

  const changeBaseline =
    context.project?.location?.kind === 'ssh'
      ? null
      : await beginWorkspaceChangeCapture(context.runSnapshot.cwd)

  let loadedSkills = deps.skills.get(context.phiSessionId)
  if (!loadedSkills) {
    try {
      loadedSkills = (await deps.skills.resolve(context.runSnapshot.cwd))
        .filter((skill) => skill.enabled)
        .map((skill) => skill.name)
        .sort()
    } catch (error) {
      loadedSkills = []
      deps.timeline.logSkillLookupFailure(context.phiSessionId, error)
    }
    deps.skills.set(context.phiSessionId, loadedSkills)
  }

  const registryRun = deps.execution.runner.startRun({
    sessionId: context.phiSessionId,
    runId: context.runId,
    loadedSkills,
    ...(context.input.researchPauses?.length
      ? { researchPauses: context.input.researchPauses }
      : {}),
    getRecordedFailure: () => context.promptRun.recordedFailureMessage,
    execute: ({ signal }) =>
      deps.execution.execute(context, signal, (result) => {
        promptResult = result
      })
  })
  if (context.input.automatic) deps.events.automaticPromptStarted?.(context.phiSessionId)
  deps.sleep.sync()
  void registryRun.done.then(deps.sleep.sync, deps.sleep.sync)
  try {
    await registryRun.done
  } finally {
    let savedDiffBytes = 0
    const changes = await finishWorkspaceChangeCapture(changeBaseline, {
      onTextDiff: async (_name, patch) => {
        const bytes = Buffer.byteLength(patch, 'utf8')
        if (savedDiffBytes + bytes > MAX_RUN_DIFF_BYTES) return null
        const ref = persistWorkspaceDiff(context.phiSessionId, patch)
        if (ref) savedDiffBytes += ref.bytes
        return ref
      }
    })
    persistWorkspaceChanges(deps, context, changes)
  }
  return context.promptRun.cancelled ? null : promptResult
}

function trackPromptRunSettlement(
  deps: PromptRunQueueDeps,
  context: PromptRunContext,
  run: Promise<PromptRunResult>
): void {
  context.promptRun.done = run
  deps.runs.setQueue(
    context.runSessionKey,
    run.then(
      (result) => {
        deps.cleanup.deleteActiveRun(context.runSessionKey, context.promptRun)
        deps.events.notifySessionChanged()
        deps.events.flushContinuations(context.phiSessionId, context.promptRun.cancelled)
        if (result && !context.promptRun.cancelled && !context.promptRun.recordedFailureMessage) {
          deps.events.scheduleTitle(context.phiSessionId)
        }
      },
      () => {
        deps.cleanup.deleteActiveRun(context.runSessionKey, context.promptRun)
        deps.events.notifySessionChanged()
        deps.events.flushContinuations(context.phiSessionId, context.promptRun.cancelled)
      }
    )
  )
}

async function submitFollowUpRun(
  deps: PromptRunQueueDeps,
  input: SubmitPromptInput
): Promise<PromptRunResult> {
  const target = deps.admission.resolve(input)
  const promptRun = deps.runs.activeRun(target.runSessionKey)
  if (
    !promptRun ||
    promptRun.cancelled ||
    promptRun.sessionGeneration !== target.runSessionGeneration ||
    !target.runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
  ) {
    throw new Error('当前运行已结束，请稍后重试')
  }
  const session = promptRun.session
  if (!session) throw new Error('当前运行正在启动，请稍后重试')
  const admission = deps.admission.admit(target, promptRun.runId)
  const context = deps.start.allocateFollowUp(admission, promptRun)
  await session.prompt(context.normalizedText, {
    hostRunId: context.runId,
    streamingBehavior: 'followUp',
    ...(context.input.images?.length
      ? {
          images: context.input.images.map((image) => ({
            type: 'image' as const,
            data: image.data,
            mimeType: image.mimeType
          }))
        }
      : {})
  })
  try {
    deps.start.prepareFollowUp(context)
  } catch (error) {
    deps.timeline.logUnexpected(error)
  }
  return {
    path: context.stableSessionPath,
    phiSessionId: context.phiSessionId,
    sessionGeneration: context.promptRun.sessionGeneration,
    ...(context.userMessageEventId ? { userMessageEventId: context.userMessageEventId } : {})
  }
}

/**
 * Runs one prompt in the conversation `sessionKey`. It does not depend on which
 * conversation is on screen, so it also serves prompts for a conversation in the
 * background. The `agent:prompt` handler and automatic continuation both use it.
 */
async function submitPromptRun(
  deps: PromptRunQueueDeps,
  input: SubmitPromptInput
): Promise<PromptRunResult> {
  if (input.promptTarget?.followUp === true) return submitFollowUpRun(deps, input)
  // A plugin/skill invalidation deferred by running background work must land before the
  // next prompt acquires the old runtime session; otherwise the prompt starts on stale resources.
  // With no deferred invalidation this is a synchronous fast path, so a stop that arrives right
  // after the prompt request still invalidates the generation before admission. While a replay
  // is awaited, the submission token lets stop cancel this prompt before it is admitted.
  const submission = deps.runs.beginSubmission(input.sessionKey)
  try {
    const pendingInvalidation = deps.invalidation.flushPending(input.sessionKey)
    if (pendingInvalidation) await pendingInvalidation
    if (submission.cancelled) return null
    const target = deps.admission.resolve(input)
    const admission = deps.admission.admit(target)
    const context = deps.start.allocate(admission)
    deps.start.prepare(context)
    // Serialize prompts per session: duplicate/overlapping IPC invokes must
    // never run session.prompt() concurrently within the same conversation.
    const run = deps.runs.queueFor(context.runSessionKey).then(() => runQueuedPrompt(deps, context))
    trackPromptRunSettlement(deps, context, run)
    return run
  } finally {
    if (submission.cancelled) input.onCancelledBeforeStart?.()
    deps.runs.endSubmission(input.sessionKey, submission)
  }
}

export interface PromptRunQueue {
  submitPromptRun(input: SubmitPromptInput): Promise<PromptRunResult>
}

export function createPromptRunQueue(deps: PromptRunQueueDeps): PromptRunQueue {
  return {
    submitPromptRun: (input) => submitPromptRun(deps, input)
  }
}
