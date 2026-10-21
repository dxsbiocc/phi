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
      target: ResolvedPromptRunTarget<CreateAgentSessionResult>
    ): AdmittedPromptRun<CreateAgentSessionResult>
  }
  start: {
    allocate(admission: AdmittedPromptRun<CreateAgentSessionResult>): PromptRunContext
    prepare(context: PromptRunContext): void
  }
  runs: {
    queueFor(sessionKey: string): Promise<void>
    generationFor(sessionKey: string): number
    setQueue(sessionKey: string, queue: Promise<void>): void
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
  events: {
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
    getRecordedFailure: () => context.promptRun.recordedFailureMessage,
    execute: ({ signal }) =>
      deps.execution.execute(context, signal, (result) => {
        promptResult = result
      })
  })
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

/**
 * Runs one prompt in the conversation `sessionKey`. It does not depend on which
 * conversation is on screen, so it also serves prompts for a conversation in the
 * background. The `agent:prompt` handler and automatic continuation both use it.
 */
async function submitPromptRun(
  deps: PromptRunQueueDeps,
  input: SubmitPromptInput
): Promise<PromptRunResult> {
  const target = deps.admission.resolve(input)
  const admission = deps.admission.admit(target)
  const context = deps.start.allocate(admission)
  deps.start.prepare(context)
  // Serialize prompts per session: duplicate/overlapping IPC invokes must
  // never run session.prompt() concurrently within the same conversation.
  const run = deps.runs.queueFor(context.runSessionKey).then(() => runQueuedPrompt(deps, context))
  trackPromptRunSettlement(deps, context, run)
  return run
}

export interface PromptRunQueue {
  submitPromptRun(input: SubmitPromptInput): Promise<PromptRunResult>
}

export function createPromptRunQueue(deps: PromptRunQueueDeps): PromptRunQueue {
  return {
    submitPromptRun: (input) => submitPromptRun(deps, input)
  }
}
