import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import {
  KERNEL_EVENT_MODELS_CHANGED,
  type ApprovalRespondParams,
  type JsonValue,
  type SessionCreateParams,
  type SessionLastRun,
  type SessionOpenParams,
  type SessionPromptParams
} from '../../shared/kernel-protocol'
import { makeProtocolError } from '../protocol/errors'
import type { KernelModelAccess } from '../model-access'
import type {
  KernelMethodHandlers,
  KernelProtocolCore,
  RunCompletionStatus,
  SessionPromptRun
} from '../protocol'
import {
  KernelSessionRepository,
  SessionWriterBusyError,
  type AcquireProcessLockGuard,
  type DuplicateRun,
  type PersistentSession
} from '../sessions'
import { createHistoryHandlers } from './history-handlers'
import { pauseKernelTestPoint } from '../test-pause'
import { bindWorkerOutbound } from './outbound'
import {
  createModelAccessWorkerHandlers,
  readModelAccessCatalog,
  requireAvailableModel
} from './model-access-handlers'
import { callKernelRuntime } from './runtime-calls'

type WorkerCall = (method: string, params: unknown) => Promise<unknown>

export type WorkerKernelAdapterOptions = {
  agentDir: string
  kernelInstanceId?: string
  callWorker?: WorkerCall
  readSessionState?: (sessionId: string) => unknown | Promise<unknown>
  diagnostic?: (message: string) => void
  /** Deterministic process identity for sandboxed lock tests; production reads the OS. */
  processStartedAt?: string
  acquireSessionLockGuard?: AcquireProcessLockGuard
  modelAccess?: KernelModelAccess
  /** Trusted roots `session.adopt` may copy journals from; empty refuses every adoption. */
  allowedSourceRoots?: readonly string[]
}

export type WorkerKernelAdapter = {
  handlers: KernelMethodHandlers
  bind(core: KernelProtocolCore): () => void
  closeAll(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw makeProtocolError('INVALID_PARAMS', 'The request requires a sessionId.')
  }
  return sessionId
}

async function defaultReadSessionState(sessionId: string): Promise<unknown> {
  const [{ getSession }, { serializeSessionState }, { toJsonSafe }] = await Promise.all([
    import('../../main/agent/engine/in-process/session-runtime'),
    import('../../main/agent/engine/in-process/tool-support'),
    import('../../main/agent/engine/in-process/common')
  ])
  // Snapshots bypass the ipc.ts wrappers, so they need their own JSON-safe pass.
  return toJsonSafe(serializeSessionState(getSession(sessionId)))
}

async function assertExistingAbsoluteDirectory(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) {
    throw makeProtocolError('INVALID_PARAMS', 'Session cwd must be an existing absolute directory.')
  }
  try {
    if ((await stat(cwd)).isDirectory()) return
  } catch {
    // The protocol exposes one stable validation result for missing and non-directory paths.
  }
  throw makeProtocolError('INVALID_PARAMS', 'Session cwd must be an existing absolute directory.')
}

const thinkingLevels = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function projectSessionState(
  sessionId: string,
  value: unknown,
  activeRunId?: string,
  lastRun?: SessionLastRun
): JsonValue {
  const state = isRecord(value) ? value : {}
  const model = isRecord(state.model) ? state.model : undefined
  const messages = Array.isArray(state.messages) ? (state.messages as JsonValue[]) : []
  const cwd = typeof state.cwd === 'string' && state.cwd ? state.cwd : undefined
  if (!cwd) throw new TypeError('Worker session state omitted cwd')
  return {
    sessionId,
    messages,
    ...(model && typeof model.provider === 'string' && typeof model.id === 'string'
      ? { model: { provider: model.provider, id: model.id } }
      : {}),
    ...(typeof state.thinkingLevel === 'string' && thinkingLevels.has(state.thinkingLevel)
      ? { thinkingLevel: state.thinkingLevel }
      : {}),
    cwd,
    ...(activeRunId ? { activeRunId } : {}),
    ...(lastRun ? { lastRun } : {})
  }
}

function sanitizeRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s:]+[\\/])*[^\s:]*/g, '<path>').slice(0, 1024)
}

function workerPromptParams(
  sessionId: string,
  prompt: SessionPromptParams
): Record<string, unknown> {
  const options = {
    ...(prompt.images ? { images: prompt.images } : {}),
    ...(prompt.modelSelection ? { modelSelection: prompt.modelSelection } : {}),
    ...(prompt.synthetic === undefined ? {} : { synthetic: prompt.synthetic }),
    ...(prompt.userInitiated === undefined ? {} : { userInitiated: prompt.userInitiated })
  }
  return {
    sessionId,
    text: prompt.text,
    ...(Object.keys(options).length ? { options } : {})
  }
}

export function createWorkerKernelAdapter(
  options: WorkerKernelAdapterOptions
): WorkerKernelAdapter {
  if (!options.agentDir) throw new Error('PI_CODING_AGENT_DIR is required by the kernel entry')

  const callWorker =
    options.callWorker ??
    ((method, params) => callKernelRuntime(method, params, options.modelAccess))
  const readSessionState = options.readSessionState ?? defaultReadSessionState
  const diagnostic =
    options.diagnostic ??
    ((message: string) => process.stderr.write(`[kernel-worker] ${message}\n`))
  const diagnosedEvents = new Set<string>()
  const durableSessions = new KernelSessionRepository(
    options.agentDir,
    options.kernelInstanceId,
    options.acquireSessionLockGuard ??
      (async (path) =>
        (
          await import('../../main/agent/engine/in-process/session-factory')
        ).acquireKernelSessionLockGuard(path)),
    options.processStartedAt
  )
  // Without trusted staging roots the method is not offered at all, so clients see it is
  // unavailable from the advertised capabilities instead of a failing call.
  const adoptRoots = options.allowedSourceRoots ?? []
  const historyHandlers =
    adoptRoots.length > 0
      ? createHistoryHandlers({ repository: durableSessions, allowedSourceRoots: adoptRoots })
      : {}
  const activeRuns = new Map<string, string>()
  const cancelledRuns = new Set<string>()
  const sessionKinds = new Map<string, 'memory' | 'persistent'>()
  const memoryClientRuns = new Map<string, Map<string, DuplicateRun>>()
  const openingSessions = new Map<string, Promise<PersistentSession>>()
  const admissions = new Set<Promise<void>>()
  let closing = false
  let closeAllPromise: Promise<void> | undefined

  const modelCatalog = (): ReturnType<typeof readModelAccessCatalog> =>
    readModelAccessCatalog(options.modelAccess)

  const withAdmission = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing) throw makeProtocolError('INTERNAL', 'The kernel is shutting down.')
    let finish!: () => void
    const admitted = new Promise<void>((resolve) => {
      finish = resolve
    })
    admissions.add(admitted)
    try {
      return await operation()
    } finally {
      admissions.delete(admitted)
      finish()
    }
  }

  const sessionNotFound = (): ReturnType<typeof makeProtocolError> =>
    makeProtocolError('SESSION_NOT_FOUND', 'The requested session is not loaded.')

  const requireLoadedSession = (sessionId: string): 'memory' | 'persistent' => {
    const kind = sessionKinds.get(sessionId)
    if (!kind) throw sessionNotFound()
    return kind
  }

  const openPersistentSession = async (sessionId: string): Promise<PersistentSession> => {
    const loaded = durableSessions.get(sessionId)
    if (loaded && sessionKinds.get(sessionId) === 'persistent') return loaded
    const pending = openingSessions.get(sessionId)
    if (pending) return pending
    const opening = (async () => {
      const session = await durableSessions.open(sessionId)
      try {
        await callWorker('session.create', {
          sessionId,
          agentDir: options.agentDir,
          cwd: session.manifest.cwd,
          ...(session.manifest.model ? { model: session.manifest.model } : {}),
          ...(session.manifest.thinkingLevel
            ? { thinkingLevel: session.manifest.thinkingLevel }
            : {}),
          sessionManager: {
            kind: 'open',
            path: session.journalPath,
            cwd: session.manifest.cwd,
            requireExisting: true,
            suppressBreadcrumb: true
          }
        })
        sessionKinds.set(sessionId, 'persistent')
        return session
      } catch (error) {
        await durableSessions.close(sessionId)
        throw error
      }
    })()
    openingSessions.set(sessionId, opening)
    try {
      return await opening
    } finally {
      if (openingSessions.get(sessionId) === opening) openingSessions.delete(sessionId)
    }
  }

  const duplicateRequest = (duplicate: DuplicateRun): ReturnType<typeof makeProtocolError> =>
    makeProtocolError(
      'DUPLICATE_REQUEST',
      'The client run key was already accepted for this session.',
      duplicate
    )

  const finishActiveRun = async (
    sessionId: string,
    runId: string,
    status: RunCompletionStatus
  ): Promise<void> => {
    const persistent = durableSessions.get(sessionId)
    if (persistent) {
      await durableSessions.finishRun(persistent, runId, status)
      return
    }
    const clientRuns = memoryClientRuns.get(sessionId)
    if (!clientRuns) return
    for (const [clientRunKey, run] of clientRuns) {
      if (run.runId === runId) clientRuns.set(clientRunKey, { runId, status })
    }
  }

  const diagnoseDroppedEvent = (name: string, reason: string): void => {
    if (diagnosedEvents.has(name)) return
    diagnosedEvents.add(name)
    diagnostic(`Dropped legacy worker event ${name}: ${reason}`)
  }

  const rejectAuthPrompt = (requestId: string): void => {
    void import('../../main/agent/engine/in-process/state')
      .then(({ pendingAuthPrompts }) => {
        const pending = pendingAuthPrompts.get(requestId)
        if (!pending) return
        pendingAuthPrompts.delete(requestId)
        pending.reject(new Error('authentication prompt unavailable in kernel v1'))
      })
      .catch((error: unknown) => {
        diagnostic(`Failed to reject kernel authentication prompt: ${String(error)}`)
      })
  }

  const modelAccessHandlers = createModelAccessWorkerHandlers({
    agentDir: options.agentDir,
    modelAccess: options.modelAccess,
    callWorker,
    requireLoadedSession,
    snapshot: async (sessionId) =>
      projectSessionState(
        sessionId,
        await readSessionState(sessionId),
        activeRuns.get(sessionId),
        durableSessions.get(sessionId)?.manifest.lastRun
      )
  })

  const handlers: KernelMethodHandlers = {
    ...modelAccessHandlers,
    ...historyHandlers,
    'session.create'(params) {
      return withAdmission(async () => {
        const create = params as SessionCreateParams
        await assertExistingAbsoluteDirectory(create.cwd)
        await requireAvailableModel(options.modelAccess, create.model)
        const sessionId = randomUUID()
        if (create.sessionManager.kind === 'memory') {
          await callWorker('session.create', {
            ...create,
            sessionId,
            agentDir: options.agentDir,
            sessionManager: { kind: 'memory', cwd: create.cwd }
          })
          sessionKinds.set(sessionId, 'memory')
          memoryClientRuns.set(sessionId, new Map())
          return { sessionId }
        }

        const persistent = await durableSessions.create(sessionId, create)
        try {
          await callWorker('session.create', {
            ...create,
            sessionId,
            agentDir: options.agentDir,
            sessionManager: {
              kind: 'persistent',
              path: persistent.journalPath,
              cwd: create.cwd
            }
          })
          sessionKinds.set(sessionId, 'persistent')
          return { sessionId }
        } catch (error) {
          await durableSessions.abandonNew(sessionId)
          throw error
        }
      })
    },
    'session.open'(params) {
      return withAdmission(async () => {
        const { sessionId } = params as SessionOpenParams
        try {
          await openPersistentSession(sessionId)
          return { sessionId }
        } catch (error) {
          if (error instanceof SessionWriterBusyError) {
            throw makeProtocolError('SESSION_BUSY', 'Another kernel owns this session.')
          }
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
          ) {
            throw makeProtocolError('SESSION_NOT_FOUND', 'The persistent session does not exist.')
          }
          throw error
        }
      })
    },
    'sessions.list'() {
      return durableSessions.list()
    },
    promptConflict(sessionId, params) {
      const clientRunKey = (params as SessionPromptParams).clientRunKey
      const activeRunId = activeRuns.get(sessionId)
      if (!clientRunKey || !activeRunId) return undefined
      const persistent = durableSessions.get(sessionId)
      const duplicate = persistent
        ? durableSessions.findDuplicate(persistent, clientRunKey)
        : memoryClientRuns.get(sessionId)?.get(clientRunKey)
      return duplicate?.runId === activeRunId && duplicate.status === 'running'
        ? { runId: activeRunId, status: 'running' }
        : undefined
    },
    'session.prompt'(params, _context, request): Promise<SessionPromptRun> {
      return withAdmission(async () => {
        const sessionId = requiredSessionId(request.sessionId)
        const prompt = params as SessionPromptParams
        const kind = requireLoadedSession(sessionId)
        const persistent = kind === 'persistent' ? durableSessions.get(sessionId) : undefined
        if (kind === 'persistent' && !persistent) throw sessionNotFound()
        if (prompt.clientRunKey) {
          const duplicate = persistent
            ? durableSessions.findDuplicate(persistent, prompt.clientRunKey)
            : memoryClientRuns.get(sessionId)?.get(prompt.clientRunKey)
          if (duplicate) throw duplicateRequest(duplicate)
        }
        const runId = randomUUID()
        if (persistent) {
          await durableSessions.acceptRun(persistent, runId, prompt.clientRunKey)
          pauseKernelTestPoint('a', options.agentDir)
        } else if (prompt.clientRunKey) {
          memoryClientRuns.get(sessionId)?.set(prompt.clientRunKey, { runId, status: 'running' })
        }
        activeRuns.set(sessionId, runId)
        const completion = (async (): Promise<
          RunCompletionStatus | { status: RunCompletionStatus; detail?: string }
        > => {
          try {
            let outcome: RunCompletionStatus | { status: RunCompletionStatus; detail?: string }
            try {
              await callWorker('session.prompt', workerPromptParams(sessionId, prompt))
              if (persistent) pauseKernelTestPoint('d1', options.agentDir)
              outcome = cancelledRuns.has(runId) ? 'cancelled' : 'completed'
            } catch (error) {
              outcome = cancelledRuns.has(runId)
                ? 'cancelled'
                : { status: 'failed', detail: sanitizeRunError(error) }
            }
            const status = typeof outcome === 'string' ? outcome : outcome.status
            if (persistent) {
              try {
                await durableSessions.finishRun(persistent, runId, status)
                pauseKernelTestPoint('d2', options.agentDir)
              } catch {
                return { status: 'unknown', detail: 'Run completion could not be persisted.' }
              }
            } else if (prompt.clientRunKey) {
              memoryClientRuns.get(sessionId)?.set(prompt.clientRunKey, { runId, status })
            }
            return outcome
          } finally {
            cancelledRuns.delete(runId)
            if (activeRuns.get(sessionId) === runId) activeRuns.delete(sessionId)
          }
        })()
        return { runId, completion }
      })
    },
    async 'session.abort'(_params, callContext, request) {
      const sessionId = requiredSessionId(request.sessionId)
      requireLoadedSession(sessionId)
      const activeRunId =
        callContext.connectionId === 'kernel-lifecycle' && request.runId
          ? request.runId
          : activeRuns.get(sessionId)
      if (activeRunId) cancelledRuns.add(activeRunId)
      try {
        await callWorker('session.abort', { sessionId })
      } catch (error) {
        if (activeRunId) cancelledRuns.delete(activeRunId)
        if (activeRunId && callContext.connectionId === 'kernel-lifecycle') {
          await finishActiveRun(sessionId, activeRunId, 'unknown')
        }
        throw error
      }
      if (activeRunId && callContext.connectionId === 'kernel-lifecycle') {
        await finishActiveRun(sessionId, activeRunId, 'cancelled')
      }
      return { cancelled: true }
    },
    async 'session.snapshot'(_params, _context, request) {
      const sessionId = requiredSessionId(request.sessionId)
      requireLoadedSession(sessionId)
      return projectSessionState(
        sessionId,
        await readSessionState(sessionId),
        activeRuns.get(sessionId),
        durableSessions.get(sessionId)?.manifest.lastRun
      )
    },
    'session.close'(_params, _context, request) {
      return withAdmission(async () => {
        const sessionId = requiredSessionId(request.sessionId)
        requireLoadedSession(sessionId)
        if (activeRuns.has(sessionId)) {
          throw makeProtocolError('SESSION_BUSY', 'The session has an active run.')
        }
        await callWorker('session.dispose', { sessionId })
        await durableSessions.close(sessionId)
        activeRuns.delete(sessionId)
        sessionKinds.delete(sessionId)
        memoryClientRuns.delete(sessionId)
        return { closed: true }
      })
    },
    'events.subscribe': () => ({ subscribed: true, lastSeq: 0 }),
    async 'approval.respond'(params, callContext, request) {
      const response = params as ApprovalRespondParams & { reason?: unknown }
      if (callContext.connectionId === 'kernel-lifecycle' && request.runId) {
        cancelledRuns.add(request.runId)
      }
      const result =
        response.decision === 'approved'
          ? null
          : {
              block: true,
              reason:
                typeof response.reason === 'string' && response.reason
                  ? response.reason
                  : 'User denied tool execution'
            }
      const accepted = await callWorker('toolApproval.result', {
        requestId: response.approvalId,
        result
      })
      if (accepted !== true) {
        throw makeProtocolError('INVALID_PARAMS', 'The approval is unknown or already answered.')
      }
      return { accepted: true }
    },
    onControllerDetached() {
      // A controller detaching is not an approval decision or a cancellation request.
      options.modelAccess?.controllerDetached?.()
    }
  }

  return {
    handlers,
    closeAll() {
      closeAllPromise ??= (async () => {
        closing = true
        await Promise.allSettled([...admissions, ...openingSessions.values()])
        const failures: unknown[] = []
        await Promise.all(
          [...sessionKinds].map(async ([sessionId, kind]) => {
            const activeRunId = activeRuns.get(sessionId)
            if (activeRunId) {
              cancelledRuns.add(activeRunId)
              try {
                await callWorker('session.abort', { sessionId })
                await finishActiveRun(sessionId, activeRunId, 'cancelled')
              } catch (error) {
                failures.push(error)
                await finishActiveRun(sessionId, activeRunId, 'unknown').catch((finishError) => {
                  failures.push(finishError)
                })
              }
            }
            try {
              await callWorker('session.dispose', { sessionId })
            } catch (error) {
              failures.push(error)
            } finally {
              if (kind === 'persistent') {
                await durableSessions.close(sessionId).catch((error: unknown) => {
                  failures.push(error)
                })
              }
              activeRuns.delete(sessionId)
              sessionKinds.delete(sessionId)
              memoryClientRuns.delete(sessionId)
            }
          })
        )
        if (failures.length > 0) throw failures[0]
        await options.modelAccess?.close?.()
      })()
      return closeAllPromise
    },
    bind(core) {
      const unbindOutbound = bindWorkerOutbound({
        agentDir: options.agentDir,
        core,
        activeRunId: (sessionId) => activeRuns.get(sessionId),
        persistentSession: (sessionId) => durableSessions.get(sessionId),
        projectSessionState,
        diagnoseDroppedEvent,
        rejectAuthPrompt
      })
      const unbindModelAccess = options.modelAccess?.onChange(() => {
        try {
          core.emitEvent(KERNEL_EVENT_MODELS_CHANGED, modelCatalog())
        } catch {
          // A transient broker read failure is already represented by provider status.
        }
      })
      return () => {
        unbindModelAccess?.()
        unbindOutbound()
        durableSessions.releaseAllSync()
      }
    }
  }
}
