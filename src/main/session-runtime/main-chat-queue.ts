import type { ChatQueueJobsVersion } from '../../shared/chatQueueTypes'
import type { PromptImageInput } from '../../shared/promptImageTypes'
import type { WorkMode } from '../../shared/sessionMode'
import { getAuthManager } from '../agent/auth-manager'
import { getProject } from '../agent/projects'
import { resolveRemoteWorkspaceHostBinding } from '../agent/remote-workspace-boundary'
import {
  resolveRuntimeModelSelection,
  selectableRuntimeModels
} from '../agent/runtime/runtime-model-selection'
import type { SessionRunnerRegistry } from '../agent/session/session-runner-registry'
import {
  findPhiSessionById,
  getSessionDir,
  readSessionEvents
} from '../agent/session/session-store'
import type { AssistantInboxEntry, ClaimedEntry, SettleResult } from './assistant-inbox'
import { createChatQueueTargets, type ChatQueueTargetOptions } from './chat-queue-target'
import { createDurableChat, type BoundChatQueueTarget, type DurableChat } from './durable-chat'
import { PromptRunDeferredError, PromptRunTargetChangedError } from './prompt-run-admission'
import type { PromptRunQueue } from './prompt-run-queue'
import type { SessionResolution } from './session-resolution'

export interface MainChatQueueOptions {
  directory: string
  identity: Pick<
    ChatQueueTargetOptions,
    'sessionKey' | 'generation' | 'draftId' | 'resolve' | 'materialize'
  >
  resolution: Pick<SessionResolution, 'projectForSession' | 'resolveSessionModelSelection'>
  runner: Pick<SessionRunnerRegistry, 'availableSlots' | 'activeCount'>
  activeAttempt(sessionKey: string): string | undefined
  compacting(sessionId: string): boolean
  submit: PromptRunQueue['submitPromptRun']
  changed(sessionId: string): void
  jobsChanged(version: ChatQueueJobsVersion): void
  log(error: unknown): void
}

export function createMainChatQueue(options: MainChatQueueOptions): DurableChat {
  const chatQueueTargets = createChatQueueTargets({
    ...options.identity,
    findSession: findPhiSessionById,
    getProject,
    remoteBinding(sessionId, projectId) {
      try {
        return resolveRemoteWorkspaceHostBinding({ sessionId, projectId }).cacheKey
      } catch {
        return undefined
      }
    }
  })

  function getQueuedPromptTarget(entry: AssistantInboxEntry): BoundChatQueueTarget | null {
    const target = chatQueueTargets.find(entry.scope.conversationId)
    if (
      !target ||
      target.scope.projectId !== entry.scope.projectId ||
      target.binding !== entry.binding
    ) {
      return null
    }
    const project = options.resolution.projectForSession(target.sessionKey, target.snapshot)
    return (project?.id ?? null) === entry.scope.projectId ? target : null
  }

  function queuedPromptCanStart(target: BoundChatQueueTarget, attemptId?: string): boolean {
    const active = options.activeAttempt(target.sessionKey)
    return (
      options.runner.availableSlots > 0 &&
      (!active || active === attemptId) &&
      !durableChat.isPaused(target.scope.conversationId) &&
      !options.compacting(target.scope.conversationId)
    )
  }

  async function prepareQueuedPrompt(
    entry: AssistantInboxEntry
  ): Promise<'ready' | 'wait' | 'invalid'> {
    const target = getQueuedPromptTarget(entry)
    if (!target) return 'invalid'
    if (!queuedPromptCanStart(target)) return 'wait'
    const auth = getAuthManager()
    const [runtime, statuses] = await Promise.all([auth.getRuntime(), auth.getProviderStatuses()])
    const configured = new Set(
      statuses.filter((item) => item.configured).map((item) => item.providerId)
    )
    const selection = options.resolution.resolveSessionModelSelection(
      target.sessionKey,
      target.snapshot
    )
    const selected = selection ? resolveRuntimeModelSelection(runtime, selection)?.model : undefined
    if (selection && !selected) return 'wait'
    const available = (selected ? [selected] : selectableRuntimeModels(runtime)).some(
      (model) =>
        configured.has(model.provider) &&
        (!entry.attachments?.length || model.supportsImages === true)
    )
    return available ? 'ready' : 'wait'
  }

  function queuedPromptOutcome(entry: ClaimedEntry): Exclude<SettleResult, 'defer'> {
    try {
      const type = readSessionEvents(entry.scope.conversationId).findLast(
        (event) =>
          event.runId === entry.attemptId &&
          (event.type === 'run_completed' ||
            event.type === 'run_failed' ||
            event.type === 'run_interrupted')
      )?.type
      if (type === 'run_completed') return 'succeeded'
      if (type === 'run_failed') return 'failed'
      if (type === 'run_interrupted') return 'cancelled'
    } catch (error) {
      options.log(error)
    }
    return 'interrupted'
  }

  async function executeQueuedPrompt(
    entry: ClaimedEntry,
    images: PromptImageInput[]
  ): Promise<SettleResult> {
    const target = getQueuedPromptTarget(entry)
    if (!target) return 'failed'
    if (!queuedPromptCanStart(target)) return 'defer'
    const { conversationId } = target.scope
    const workMode: WorkMode =
      entry.mode === 'plan-execute' ? 'plan_execute' : (entry.mode ?? target.workMode)
    try {
      await options.submit({
        sessionKey: target.sessionKey,
        snapshot: target.snapshot,
        text: entry.text,
        images,
        promptTarget: {
          path: target.path,
          cwd: target.snapshot.cwd,
          phiSessionId: conversationId,
          ...(entry.retryUserMessageId
            ? {
                suppressUserMessageEvent: true,
                retryUserMessageId: entry.retryUserMessageId
              }
            : {})
        },
        durable: {
          sessionId: conversationId,
          submissionId: entry.id,
          attemptId: entry.attemptId,
          workMode,
          revalidate() {
            const current = getQueuedPromptTarget(entry)
            if (!current || current.sessionKey !== target.sessionKey) {
              throw new PromptRunTargetChangedError()
            }
            if (
              !queuedPromptCanStart(current, entry.attemptId) ||
              current.snapshot.permissionMode !== target.snapshot.permissionMode
            ) {
              throw new PromptRunDeferredError()
            }
          }
        }
      })
    } catch (error) {
      if (error instanceof PromptRunDeferredError) return 'defer'
      if (error instanceof PromptRunTargetChangedError) return 'failed'
      options.log(error)
    }
    return queuedPromptOutcome(entry)
  }

  const durableChat = createDurableChat({
    directory: options.directory,
    bind: chatQueueTargets.bind,
    sessionDirectory: getSessionDir,
    scope: (sessionId) => {
      const manifest = findPhiSessionById(sessionId)
      return manifest ? { conversationId: sessionId, projectId: manifest.projectId } : null
    },
    jobOwner: findPhiSessionById,
    prepare: prepareQueuedPrompt,
    capacity: () => options.runner.availableSlots + options.runner.activeCount,
    execute: executeQueuedPrompt,
    recoverOutcome: queuedPromptOutcome,
    changed: options.changed,
    jobsChanged: options.jobsChanged,
    log: options.log
  })
  return durableChat
}
