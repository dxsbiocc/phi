import { randomUUID } from 'node:crypto'

import {
  KERNEL_EVENT_MODELS_CHANGED,
  type ApprovalRespondParams,
  type JsonValue,
  type SessionCreateParams,
  type SessionOpenParams,
  type SessionPolicyParams
} from '../../shared/kernel-protocol'
import { makeProtocolError, writerBusyProtocolError } from '../protocol/errors'
import type { KernelModelAccess } from '../model-access'
import type { KernelMethodHandlers, KernelProtocolCore, RunCompletionStatus } from '../protocol'
import {
  KernelSessionRepository,
  SessionWriterBusyError,
  type AcquireProcessLockGuard,
  type DuplicateRun,
  type PersistentSession
} from '../sessions'
import { createHistoryHandlers } from './history-handlers'
import { createResourceHandlers } from './resource-handlers'
import { createSessionForkHandlers } from './session-fork-handlers'
import { createPromptHandlers } from './prompt-handlers'
import { bindWorkerOutbound } from './outbound'
import {
  createModelAccessWorkerHandlers,
  readModelAccessCatalog,
  refreshModelAccessCatalog,
  requireAvailableModel
} from './model-access-handlers'
import { callKernelRuntime } from './runtime-calls'
import { createPlanAgentHandlers } from './plan-agent-handlers'
import {
  assertExistingAbsoluteDirectory,
  hasTrustedSessionResources,
  projectSessionState
} from './session-state'
import { KernelAgentRunCoordinator } from '../agent-runs/coordinator'
import { KernelPlanCoordinator } from '../plans/coordinator'
import type { KernelRuntimeServices } from '../../main/agent/engine/in-process/kernel-services'
import { createDesktopMemoryHandlers } from './desktop-memory-handlers'
import { updatePersistentSessionSelection } from '../sessions/selection'
import {
  kernelRunCompletionMetadata,
  kernelSessionSelectionFromState,
  updateKernelSessionSelection
} from './completion-metadata'
import { rejectKernelAuthPrompt } from './auth-prompt'

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

export function createWorkerKernelAdapter(
  options: WorkerKernelAdapterOptions
): WorkerKernelAdapter {
  if (!options.agentDir) throw new Error('PI_CODING_AGENT_DIR is required by the kernel entry')

  const readSessionState = options.readSessionState ?? defaultReadSessionState
  const diagnostic =
    options.diagnostic ??
    ((message: string) => process.stderr.write(`[kernel-worker] ${message}\n`))
  const kernelServices: KernelRuntimeServices = {}
  const callWorker =
    options.callWorker ??
    ((method, params) => callKernelRuntime(method, params, options.modelAccess, kernelServices))
  const agentRuns = new KernelAgentRunCoordinator(options.agentDir, callWorker, diagnostic)
  const plans = new KernelPlanCoordinator(options.agentDir, callWorker, diagnostic, (id, request) =>
    agentRuns.launchSettled(id, request)
  )
  kernelServices.agentRuns = agentRuns
  kernelServices.plans = plans
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
  const admittingRuns = new Set<string>()
  const cancelledRuns = new Set<string>()
  const forkingSessions = new Set<string>()
  const sessionKinds = new Map<string, 'memory' | 'persistent'>()
  const sessionCreateInputs = new Map<string, Record<string, unknown>>()
  const memoryClientRuns = new Map<string, Map<string, DuplicateRun>>()
  const openingSessions = new Map<string, Promise<PersistentSession>>()
  const admissions = new Set<Promise<void>>()
  let boundCore: KernelProtocolCore | undefined
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

  const openPersistentSession = async (
    sessionId: string,
    resources?: SessionPolicyParams,
    hostCapabilities: ReadonlySet<string> = new Set()
  ): Promise<PersistentSession> => {
    const loaded = durableSessions.get(sessionId)
    if (loaded && sessionKinds.get(sessionId) === 'persistent') {
      if (resources) {
        const input = sessionCreateInputs.get(sessionId)
        if (
          typeof resources.resourceVersion === 'string' &&
          resources.resourceVersion === input?.resourceVersion
        ) {
          return loaded
        }
        if (
          activeRuns.has(sessionId) ||
          admittingRuns.has(sessionId) ||
          forkingSessions.has(sessionId) ||
          plans.hasActiveWork(sessionId)
        ) {
          // Never refuse to reopen a busy session; the next open retries the refresh.
          return loaded
        }
        const refreshed = await callWorker('resources.reload', {
          ...resources,
          agentDir: options.agentDir,
          sessionId
        })
        const result =
          refreshed && typeof refreshed === 'object' && !Array.isArray(refreshed)
            ? (refreshed as Record<string, unknown>)
            : undefined
        const agents =
          result?.agents && typeof result.agents === 'object' && !Array.isArray(result.agents)
            ? (result.agents as Record<string, unknown>)
            : undefined
        // Agent changes that cannot be applied in place wait for a full session refresh;
        // the session stays usable with its current agents meanwhile.
        if (agents?.applied === false) return loaded
        if (input) Object.assign(input, structuredClone(resources))
      }
      return loaded
    }
    const pending = openingSessions.get(sessionId)
    if (pending) return pending
    const opening = (async () => {
      const session = await durableSessions.open(sessionId)
      const persistedPolicy = session.manifest.policy?.sessionPolicy
      const createInput = {
        cwd: session.manifest.cwd,
        ...(session.manifest.thinkingLevel
          ? { thinkingLevel: session.manifest.thinkingLevel }
          : {}),
        sessionManager: { kind: 'persistent' as const },
        ...(resources ?? {}),
        ...(persistedPolicy
          ? {
              ...persistedPolicy,
              ...(persistedPolicy.autoCompaction
                ? { autoCompaction: { ...persistedPolicy.autoCompaction } }
                : {})
            }
          : {}),
        ...(session.manifest.policy?.projectBound ? { projectBound: true } : {})
      }
      try {
        if (session.manifest.policy?.requiresTrustedResources && !resources) {
          throw makeProtocolError(
            'CAPABILITY_UNAVAILABLE',
            'The persistent session requires a trusted resource snapshot.',
            { reason: 'resource_snapshot_required' }
          )
        }
        await refreshModelAccessCatalog(options.modelAccess)
        await agentRuns.openSession(sessionId, session.directory)
        const created = await callWorker('session.create', {
          ...createInput,
          desktopServices: true,
          desktopHostCapabilities: [...hostCapabilities],
          sessionId,
          agentDir: options.agentDir,
          sessionManager: {
            kind: 'open',
            path: session.journalPath,
            cwd: session.manifest.cwd,
            requireExisting: true,
            suppressBreadcrumb: true
          }
        })
        const restoredSelection = kernelSessionSelectionFromState(created)
        sessionKinds.set(sessionId, 'persistent')
        sessionCreateInputs.set(sessionId, {
          ...createInput,
          ...restoredSelection,
          desktopServices: true,
          desktopHostCapabilities: [...hostCapabilities]
        })
        await plans.openSession(sessionId)
        return session
      } catch (error) {
        plans.closeSession(sessionId)
        await agentRuns.closeSession(sessionId).catch(() => undefined)
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

  const resourceHandlers = createResourceHandlers({
    agentDir: options.agentDir,
    callWorker,
    requireLoadedSession
  })
  const sessionForkHandlers = createSessionForkHandlers({
    agentDir: options.agentDir,
    callWorker,
    repository: durableSessions,
    activeRuns,
    admittingRuns,
    forkingSessions,
    sessionKinds,
    sessionCreateInputs,
    initializeMemorySession: (sessionId) => memoryClientRuns.set(sessionId, new Map()),
    prepareTarget: (sessionId, directory) => agentRuns.openSession(sessionId, directory),
    activateTarget: (sessionId) => plans.openSession(sessionId),
    cleanupTarget: async (sessionId) => {
      plans.closeSession(sessionId)
      await agentRuns.closeSession(sessionId)
    },
    withAdmission,
    requireLoadedSession
  })
  const promptHandlers = createPromptHandlers({
    agentDir: options.agentDir,
    callWorker,
    repository: durableSessions,
    activeRuns,
    admittingRuns,
    cancelledRuns,
    forkingSessions,
    memoryClientRuns,
    requireLoadedSession,
    sessionNotFound,
    duplicateRequest,
    withAdmission
  })
  const desktopMemoryHandlers = createDesktopMemoryHandlers({
    core: () => boundCore,
    sessionCreateInputs,
    persistentSession: (sessionId) => durableSessions.get(sessionId),
    requireLoadedSession
  })

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

  const modelAccessHandlers = createModelAccessWorkerHandlers({
    agentDir: options.agentDir,
    modelAccess: options.modelAccess,
    callWorker,
    requireLoadedSession,
    async updateSelection(sessionId, patch) {
      updateKernelSessionSelection(sessionCreateInputs, sessionId, patch)
      await updatePersistentSessionSelection(durableSessions.get(sessionId), patch)
    },
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
    ...resourceHandlers,
    ...sessionForkHandlers,
    ...promptHandlers,
    ...createPlanAgentHandlers({ callWorker, plans, agentRuns, requireLoadedSession }),
    ...desktopMemoryHandlers,
    'session.create'(params, callContext) {
      return withAdmission(async () => {
        const create = params as SessionCreateParams
        if (!callContext.trusted && hasTrustedSessionResources(create)) {
          throw makeProtocolError(
            'CAPABILITY_UNAVAILABLE',
            'Session resources require a trusted host connection.',
            { reason: 'trusted_host_required' }
          )
        }
        await assertExistingAbsoluteDirectory(create.cwd)
        await requireAvailableModel(options.modelAccess, create.model)
        const sessionId = randomUUID()
        const desktopHostCapabilities = [...(callContext.hostCapabilities ?? [])]
        if (create.sessionManager.kind === 'memory') {
          await agentRuns.openSession(sessionId)
          try {
            await callWorker('session.create', {
              ...create,
              desktopServices: true,
              desktopHostCapabilities,
              sessionId,
              agentDir: options.agentDir,
              sessionManager: { kind: 'memory', cwd: create.cwd }
            })
            sessionKinds.set(sessionId, 'memory')
            sessionCreateInputs.set(sessionId, {
              ...(create as unknown as Record<string, unknown>),
              desktopServices: true,
              desktopHostCapabilities
            })
            memoryClientRuns.set(sessionId, new Map())
            await plans.openSession(sessionId)
            return { sessionId } as JsonValue
          } catch (error) {
            plans.closeSession(sessionId)
            await agentRuns.closeSession(sessionId).catch(() => undefined)
            throw error
          }
        }

        const persistent = await durableSessions.create(sessionId, create)
        try {
          await agentRuns.openSession(sessionId, persistent.directory)
          await callWorker('session.create', {
            ...create,
            desktopServices: true,
            desktopHostCapabilities,
            sessionId,
            agentDir: options.agentDir,
            sessionManager: {
              kind: 'persistent',
              path: persistent.journalPath,
              cwd: create.cwd
            }
          })
          sessionKinds.set(sessionId, 'persistent')
          sessionCreateInputs.set(sessionId, {
            ...(create as unknown as Record<string, unknown>),
            desktopServices: true,
            desktopHostCapabilities
          })
          await plans.openSession(sessionId)
          return { sessionId, sessionFile: persistent.journalPath } as JsonValue
        } catch (error) {
          plans.closeSession(sessionId)
          await agentRuns.closeSession(sessionId).catch(() => undefined)
          await durableSessions.abandonNew(sessionId)
          throw error
        }
      })
    },
    'session.open'(params, callContext) {
      return withAdmission(async () => {
        const { sessionId, resources } = params as SessionOpenParams
        if (resources && !callContext.trusted) {
          throw makeProtocolError(
            'CAPABILITY_UNAVAILABLE',
            'Session resources require a trusted host connection.',
            { reason: 'trusted_host_required' }
          )
        }
        try {
          await openPersistentSession(sessionId, resources, callContext.hostCapabilities)
          return { sessionId }
        } catch (error) {
          if (error instanceof SessionWriterBusyError) {
            throw writerBusyProtocolError(error)
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
    async 'session.abort'(_params, callContext, request) {
      const sessionId = requiredSessionId(request.sessionId)
      requireLoadedSession(sessionId)
      if (admittingRuns.has(sessionId)) {
        throw makeProtocolError('SESSION_BUSY', 'The session is admitting a run.')
      }
      const activeRunId =
        callContext.connectionId === 'kernel-lifecycle' && request.runId
          ? request.runId
          : activeRuns.get(sessionId)
      if (activeRunId) cancelledRuns.add(activeRunId)
      // Plan children are kernel-owned. Mark their steps interrupted before stopAll
      // cancels them, or the executor will treat cancellation as a failed attempt.
      // A bookkeeping failure must not block the stop itself.
      await plans.interruptRunningSteps(sessionId).catch(() => undefined)
      const [childAbort, mainAbort] = await Promise.allSettled([
        agentRuns.stopAll(sessionId),
        callWorker('session.abort', { sessionId })
      ])
      if (mainAbort.status === 'rejected') {
        if (activeRunId) cancelledRuns.delete(activeRunId)
        if (activeRunId && callContext.connectionId === 'kernel-lifecycle') {
          await finishActiveRun(sessionId, activeRunId, 'unknown')
        }
        throw mainAbort.reason
      }
      if (activeRunId && callContext.connectionId === 'kernel-lifecycle') {
        await finishActiveRun(sessionId, activeRunId, 'cancelled')
      }
      if (childAbort.status === 'rejected') throw childAbort.reason
      return { cancelled: true }
    },
    async 'session.snapshot'(_params, _context, request) {
      const sessionId = requiredSessionId(request.sessionId)
      requireLoadedSession(sessionId)
      if (admittingRuns.has(sessionId)) {
        throw makeProtocolError('SESSION_BUSY', 'The session is admitting a run.')
      }
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
        if (
          activeRuns.has(sessionId) ||
          admittingRuns.has(sessionId) ||
          forkingSessions.has(sessionId) ||
          plans.hasActiveWork(sessionId) ||
          (await agentRuns.hasActive(sessionId))
        ) {
          throw makeProtocolError('SESSION_BUSY', 'The session has an active operation.')
        }
        await callWorker('session.dispose', { sessionId })
        plans.closeSession(sessionId)
        await agentRuns.closeSession(sessionId)
        await durableSessions.close(sessionId)
        activeRuns.delete(sessionId)
        sessionKinds.delete(sessionId)
        sessionCreateInputs.delete(sessionId)
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
    runCompletionMetadata: (sessionId) =>
      kernelRunCompletionMetadata(sessionCreateInputs, sessionId),
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
            await plans.interruptRunningSteps(sessionId).catch((error: unknown) => {
              failures.push(error)
            })
            await plans.suspendSession(sessionId).catch((error: unknown) => {
              failures.push(error)
            })
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
              await agentRuns.stopAll(sessionId)
            } catch (error) {
              failures.push(error)
            }
            try {
              await callWorker('session.dispose', { sessionId })
            } catch (error) {
              failures.push(error)
            } finally {
              plans.closeSession(sessionId)
              await agentRuns.closeSession(sessionId).catch((error: unknown) => {
                failures.push(error)
              })
              if (kind === 'persistent') {
                await durableSessions.close(sessionId).catch((error: unknown) => {
                  failures.push(error)
                })
              }
              activeRuns.delete(sessionId)
              sessionKinds.delete(sessionId)
              sessionCreateInputs.delete(sessionId)
              memoryClientRuns.delete(sessionId)
            }
          })
        )
        await agentRuns.flush().catch((error: unknown) => failures.push(error))
        if (failures.length > 0) throw failures[0]
        await options.modelAccess?.close?.()
      })()
      return closeAllPromise
    },
    bind(core) {
      agentRuns.bind(core)
      plans.bind(core)
      boundCore = core
      const unbindOutbound = bindWorkerOutbound({
        agentDir: options.agentDir,
        core,
        activeRunId: (sessionId) => activeRuns.get(sessionId),
        persistentSession: (sessionId) => durableSessions.get(sessionId),
        projectSessionState,
        diagnoseDroppedEvent,
        rejectAuthPrompt: (requestId) => rejectKernelAuthPrompt(requestId, diagnostic)
      })
      const unbindModelAccess = options.modelAccess?.onChange(() => {
        try {
          core.emitEvent(KERNEL_EVENT_MODELS_CHANGED, modelCatalog())
        } catch {
          // A transient broker read failure is already represented by provider status.
        }
      })
      return () => {
        if (boundCore === core) boundCore = undefined
        unbindModelAccess?.()
        unbindOutbound()
        durableSessions.releaseAllSync()
      }
    }
  }
}
