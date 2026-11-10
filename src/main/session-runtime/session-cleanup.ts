import type { SessionLifecycleRegistry } from '../app-state/session-lifecycle-registry'
import { errorMessage } from '../../shared/errorCodes'
import {
  isStaleSessionError,
  type SessionLifecycleRecord,
  type SessionSnapshot
} from '../agent/session/session-lifecycle'

export interface CleanupSession {
  sessionFile?: string
  abort(options?: { preserveApprovals?: boolean }): Promise<void>
  dispose(): Promise<void>
}

interface CleanupSessionResult<TSession extends CleanupSession> {
  session: TSession
}

export interface SessionCleanupDeps<
  TSession extends CleanupSession,
  TResult extends CleanupSessionResult<TSession>
> {
  lifecycles: Pick<
    SessionLifecycleRegistry<TResult>,
    | 'abortControllerFor'
    | 'deleteAbortController'
    | 'registerCleanupForPath'
    | 'registerUnknownPathCleanup'
    | 'replaceCleanupForPathIfDifferent'
    | 'releaseCleanupForPath'
    | 'releaseUnknownPathCleanup'
  >
  sessions: {
    abortSession(session: TSession): Promise<void>
    abortSessionWithoutCancellingApprovals(session: TSession): Promise<void>
  }
  errors: {
    isCleanupStarted(): boolean
    reportUnexpectedCleanupError(error: unknown): void
  }
}

export interface SessionCleanup<
  TSession extends CleanupSession,
  TResult extends CleanupSessionResult<TSession>
> {
  getSessionControllerKey(snapshot: SessionSnapshot, generation: number): string
  abortAndDisposeSession(session: TSession, options: { cancelApprovals: boolean }): Promise<void>
  cleanupSessionRecord(
    record: SessionLifecycleRecord<TResult> | null,
    options?: { cancelApprovals: boolean }
  ): Promise<void>
}

export function createSessionCleanup<
  TSession extends CleanupSession,
  TResult extends CleanupSessionResult<TSession>
>(deps: SessionCleanupDeps<TSession, TResult>): SessionCleanup<TSession, TResult> {
  const isExpectedShutdownCleanupError = (error: unknown): boolean =>
    errorMessage(error).includes('OMP worker exited (130)')

  const getSessionControllerKey = (snapshot: SessionSnapshot, generation: number): string =>
    `${snapshot.path ?? `fresh:${snapshot.cwd}`}:${generation}`

  const abortAndDisposeSession = async (
    session: TSession,
    options: { cancelApprovals: boolean }
  ): Promise<void> => {
    if (options.cancelApprovals) {
      await deps.sessions.abortSession(session)
    } else {
      await deps.sessions.abortSessionWithoutCancellingApprovals(session)
    }
    await session.dispose()
  }

  const cleanupSessionRecord = async (
    record: SessionLifecycleRecord<TResult> | null,
    options: { cancelApprovals: boolean } = { cancelApprovals: false }
  ): Promise<void> => {
    if (!record) return

    const controller = deps.lifecycles.abortControllerFor(
      getSessionControllerKey(record.snapshot, record.generation)
    )
    controller?.abort()

    const barrier: { promise: Promise<void> | null } = { promise: null }
    barrier.promise = (async (): Promise<void> => {
      let resolvedPath = record.snapshot.path
      try {
        const { session } = await record.promise
        resolvedPath = session.sessionFile ?? resolvedPath
        if (resolvedPath && barrier.promise) {
          deps.lifecycles.replaceCleanupForPathIfDifferent(resolvedPath, barrier.promise)
        }
        await abortAndDisposeSession(session, options)
      } catch (error) {
        if (
          !isStaleSessionError(error) &&
          !(deps.errors.isCleanupStarted() && isExpectedShutdownCleanupError(error))
        ) {
          deps.errors.reportUnexpectedCleanupError(error)
        }
      } finally {
        deps.lifecycles.deleteAbortController(
          getSessionControllerKey(record.snapshot, record.generation)
        )
        if (barrier.promise) {
          deps.lifecycles.releaseUnknownPathCleanup(barrier.promise)
        }
        if (resolvedPath) {
          deps.lifecycles.releaseCleanupForPath(resolvedPath, barrier.promise)
        }
      }
    })()

    if (record.snapshot.path) {
      deps.lifecycles.registerCleanupForPath(record.snapshot.path, barrier.promise)
    } else if (barrier.promise) {
      deps.lifecycles.registerUnknownPathCleanup(barrier.promise)
    }

    await barrier.promise
  }

  return { getSessionControllerKey, abortAndDisposeSession, cleanupSessionRecord }
}
