import { randomUUID } from 'node:crypto'

import type { SessionPromptParams } from '../../shared/kernel-protocol'
import { makeProtocolError, sanitizedRunFailureDetail } from '../protocol/errors'
import type { KernelMethodHandlers, RunCompletionStatus, SessionPromptRun } from '../protocol'
import type { DuplicateRun, KernelSessionRepository, PersistentSession } from '../sessions'
import { pauseKernelTestPoint } from '../test-pause'

type WorkerCall = (method: string, params: unknown) => Promise<unknown>
type SessionKind = 'memory' | 'persistent'
type PromptOutcome = RunCompletionStatus | { status: RunCompletionStatus; detail?: string }

export interface PromptHandlerOptions {
  agentDir: string
  callWorker: WorkerCall
  repository: KernelSessionRepository
  activeRuns: Map<string, string>
  admittingRuns: Set<string>
  cancelledRuns: Set<string>
  forkingSessions: ReadonlySet<string>
  memoryClientRuns: Map<string, Map<string, DuplicateRun>>
  requireLoadedSession(sessionId: string): SessionKind
  sessionNotFound(): ReturnType<typeof makeProtocolError>
  duplicateRequest(duplicate: DuplicateRun): ReturnType<typeof makeProtocolError>
  withAdmission<T>(operation: () => Promise<T>): Promise<T>
}

function requiredSessionId(sessionId: string | undefined): string {
  if (!sessionId) throw makeProtocolError('INVALID_PARAMS', 'The request requires a sessionId.')
  return sessionId
}

function workerOptions(prompt: SessionPromptParams): Record<string, unknown> | undefined {
  const publicOptions = prompt.options
  const images = publicOptions?.images ?? prompt.images
  const options = {
    ...(images ? { images } : {}),
    ...(publicOptions?.expandPromptTemplates !== undefined
      ? { expandPromptTemplates: publicOptions.expandPromptTemplates }
      : {}),
    ...(publicOptions?.skipCompactionCheck !== undefined
      ? { skipCompactionCheck: publicOptions.skipCompactionCheck }
      : {}),
    ...(prompt.modelSelection !== undefined ? { modelSelection: prompt.modelSelection } : {}),
    ...(prompt.synthetic !== undefined ? { synthetic: prompt.synthetic } : {}),
    ...(prompt.userInitiated !== undefined ? { userInitiated: prompt.userInitiated } : {})
  }
  return Object.keys(options).length > 0 ? options : undefined
}

async function finishPrompt(
  options: PromptHandlerOptions,
  input: {
    sessionId: string
    runId: string
    prompt: SessionPromptParams
    persistent?: PersistentSession
  }
): Promise<PromptOutcome> {
  const { sessionId, runId, prompt, persistent } = input
  let outcome: PromptOutcome
  try {
    const optionsValue = workerOptions(prompt)
    await options.callWorker('session.prompt', {
      sessionId,
      text: prompt.text,
      ...(optionsValue ? { options: optionsValue } : {})
    })
    if (persistent) pauseKernelTestPoint('d1', options.agentDir)
    outcome = options.cancelledRuns.has(runId) ? 'cancelled' : 'completed'
  } catch (error) {
    outcome = options.cancelledRuns.has(runId)
      ? 'cancelled'
      : { status: 'failed', detail: sanitizedRunFailureDetail(error) }
  }
  const status = typeof outcome === 'string' ? outcome : outcome.status
  if (persistent) {
    try {
      await options.repository.finishRun(persistent, runId, status)
      pauseKernelTestPoint('d2', options.agentDir)
    } catch {
      return { status: 'unknown', detail: 'Run completion could not be persisted.' }
    }
  } else if (prompt.clientRunKey) {
    options.memoryClientRuns.get(sessionId)?.set(prompt.clientRunKey, { runId, status })
  }
  return outcome
}

export function createPromptHandlers(options: PromptHandlerOptions): KernelMethodHandlers {
  return {
    promptConflict(sessionId, params) {
      const clientRunKey = (params as SessionPromptParams).clientRunKey
      const activeRunId = options.activeRuns.get(sessionId)
      if (!clientRunKey || !activeRunId) return undefined
      const persistent = options.repository.get(sessionId)
      const duplicate = persistent
        ? options.repository.findDuplicate(persistent, clientRunKey)
        : options.memoryClientRuns.get(sessionId)?.get(clientRunKey)
      return duplicate?.runId === activeRunId && duplicate.status === 'running'
        ? { runId: activeRunId, status: 'running' }
        : undefined
    },
    'session.prompt'(params, _callContext, request): Promise<SessionPromptRun> {
      return options.withAdmission(async () => {
        const sessionId = requiredSessionId(request.sessionId)
        const prompt = params as SessionPromptParams
        const kind = options.requireLoadedSession(sessionId)
        if (options.admittingRuns.has(sessionId) || options.forkingSessions.has(sessionId)) {
          throw makeProtocolError('SESSION_BUSY', 'The session has an active operation.')
        }
        const persistent = kind === 'persistent' ? options.repository.get(sessionId) : undefined
        if (kind === 'persistent' && !persistent) throw options.sessionNotFound()
        if (prompt.clientRunKey) {
          const duplicate = persistent
            ? options.repository.findDuplicate(persistent, prompt.clientRunKey)
            : options.memoryClientRuns.get(sessionId)?.get(prompt.clientRunKey)
          if (duplicate) throw options.duplicateRequest(duplicate)
        }
        const runId = randomUUID()
        options.admittingRuns.add(sessionId)
        try {
          if (persistent) {
            await options.repository.acceptRun(persistent, runId, prompt.clientRunKey)
            pauseKernelTestPoint('a', options.agentDir)
          } else if (prompt.clientRunKey) {
            options.memoryClientRuns
              .get(sessionId)
              ?.set(prompt.clientRunKey, { runId, status: 'running' })
          }
          options.activeRuns.set(sessionId, runId)
        } finally {
          options.admittingRuns.delete(sessionId)
        }
        const completion = finishPrompt(options, { sessionId, runId, prompt, persistent }).finally(
          () => {
            options.cancelledRuns.delete(runId)
            if (options.activeRuns.get(sessionId) === runId) options.activeRuns.delete(sessionId)
          }
        )
        return { runId, completion }
      })
    }
  }
}
