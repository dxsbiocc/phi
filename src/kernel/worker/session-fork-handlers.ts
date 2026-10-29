import { randomUUID } from 'node:crypto'

import type { JsonValue, SessionForkParams } from '../../shared/kernel-protocol'
import { makeProtocolError } from '../protocol/errors'
import type { KernelMethodHandlers } from '../protocol'
import type { KernelSessionRepository, PersistentSession } from '../sessions'

type SessionKind = 'memory' | 'persistent'
type WorkerCall = (method: string, params: unknown) => Promise<unknown>

export type SessionForkHandlerOptions = {
  agentDir: string
  callWorker: WorkerCall
  repository: KernelSessionRepository
  activeRuns: ReadonlyMap<string, string>
  admittingRuns: ReadonlySet<string>
  forkingSessions: Set<string>
  sessionKinds: Map<string, SessionKind>
  sessionCreateInputs: Map<string, Record<string, unknown>>
  initializeMemorySession(sessionId: string): void
  prepareTarget(sessionId: string, directory?: string): Promise<void>
  activateTarget(sessionId: string): Promise<void>
  cleanupTarget(sessionId: string): Promise<void>
  withAdmission<T>(operation: () => Promise<T>): Promise<T>
  requireLoadedSession(sessionId: string): SessionKind
}

function requiredSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw makeProtocolError('INVALID_PARAMS', 'The request requires a sessionId.')
  }
  return sessionId
}

function persistentCreateInput(source: PersistentSession): Record<string, unknown> {
  return {
    cwd: source.manifest.cwd,
    ...(source.manifest.model ? { model: source.manifest.model } : {}),
    ...(source.manifest.thinkingLevel ? { thinkingLevel: source.manifest.thinkingLevel } : {}),
    sessionManager: { kind: 'persistent' }
  }
}

function sessionBusy(options: SessionForkHandlerOptions, sessionId: string): boolean {
  return (
    options.activeRuns.has(sessionId) ||
    options.admittingRuns.has(sessionId) ||
    options.forkingSessions.has(sessionId)
  )
}

function optionalCut(params: SessionForkParams): Partial<Pick<SessionForkParams, 'cut'>> {
  return params.cut ? { cut: params.cut } : {}
}

function forkResult(sessionId: string, persistent?: PersistentSession): JsonValue {
  return persistent ? { sessionId, sessionFile: persistent.journalPath } : { sessionId }
}

/** Fork keyed only by source request identity; an absent cut retains K3-2 whole history. */
export function createSessionForkHandlers(
  options: SessionForkHandlerOptions
): KernelMethodHandlers {
  return {
    'session.fork'(params, _context, request) {
      return options.withAdmission(async () => {
        const fork = params as SessionForkParams
        const sourceSessionId = requiredSessionId(request.sessionId)
        const kind = options.requireLoadedSession(sourceSessionId)
        if (sessionBusy(options, sourceSessionId)) {
          throw makeProtocolError(
            'SESSION_BUSY',
            'The session cannot be forked during an active run.'
          )
        }

        const persistentSource =
          kind === 'persistent' ? options.repository.get(sourceSessionId) : undefined
        if (kind === 'persistent' && !persistentSource) {
          throw makeProtocolError('SESSION_NOT_FOUND', 'The requested session is not loaded.')
        }
        const create =
          options.sessionCreateInputs.get(sourceSessionId) ??
          (persistentSource ? persistentCreateInput(persistentSource) : undefined)
        if (!create) {
          throw makeProtocolError('SESSION_NOT_FOUND', 'The requested session is not loaded.')
        }

        options.forkingSessions.add(sourceSessionId)
        const targetSessionId = randomUUID()
        let persistentTarget: PersistentSession | undefined
        try {
          if (persistentSource) {
            persistentTarget = await options.repository.createFork(
              targetSessionId,
              persistentSource
            )
          }
          const sessionManager = persistentTarget
            ? {
                kind: 'persistent' as const,
                path: persistentTarget.journalPath,
                cwd: persistentTarget.manifest.cwd
              }
            : { kind: 'memory' as const, cwd: String(create.cwd ?? '') }
          await options.prepareTarget(targetSessionId, persistentTarget?.directory)
          await options.callWorker('session.fork', {
            sourceSessionId,
            targetSessionId,
            agentDir: options.agentDir,
            create,
            sessionManager,
            ...optionalCut(fork)
          })
          options.sessionKinds.set(targetSessionId, kind)
          if (kind === 'memory') options.initializeMemorySession(targetSessionId)
          options.sessionCreateInputs.set(targetSessionId, {
            ...create,
            sessionManager: { kind }
          })
          await options.activateTarget(targetSessionId)
          return forkResult(targetSessionId, persistentTarget)
        } catch (error) {
          await options.cleanupTarget(targetSessionId).catch(() => undefined)
          if (persistentTarget) await options.repository.abandonNew(targetSessionId)
          throw error
        } finally {
          options.forkingSessions.delete(sourceSessionId)
        }
      })
    }
  }
}
