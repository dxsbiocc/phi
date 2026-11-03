import {
  sessionAdoptParamsSchema,
  type SessionAdoptParams
} from '../../shared/kernel-protocol/history'
import { makeProtocolError, writerBusyProtocolError } from '../protocol/errors'
import type { KernelMethodHandler } from '../protocol/types'
import {
  KernelSessionRepository,
  SessionWriterBusyError,
  type ContinueMigrationOptions
} from '../sessions'

export type HistoryHandlerOptions = {
  repository: KernelSessionRepository
  /** Trusted roots supplied by the local entry or remote helper, never by the request. */
  allowedSourceRoots: readonly string[]
  migrationTestHooks?: Pick<ContinueMigrationOptions, 'pauseAfterState' | 'validateJournal'>
}

export type HistoryKernelMethodHandlers = {
  'session.adopt': KernelMethodHandler
}

function invalidParams(message: string): ReturnType<typeof makeProtocolError> {
  return makeProtocolError('INVALID_PARAMS', message)
}

/** Kept in the worker adapter so the kernel persistence layer has no SDK dependency. */
export async function validateHistoryJournal(path: string, cwd: string): Promise<void> {
  const { makeSessionManager } = await import('../../main/agent/engine/in-process/session-factory')
  const manager = await makeSessionManager(
    { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true },
    cwd,
    ''
  )
  try {
    if (manager.getCwd() !== cwd) throw new Error('adopted journal cwd changed during validation')
  } finally {
    await manager.close()
  }
}

export function createHistoryHandlers(options: HistoryHandlerOptions): HistoryKernelMethodHandlers {
  if (options.allowedSourceRoots.length === 0) {
    throw new Error('session.adopt requires at least one trusted source root')
  }
  const validateJournal = options.migrationTestHooks?.validateJournal ?? validateHistoryJournal
  options.repository.configureMigrationJournalValidator(validateJournal)
  return {
    async 'session.adopt'(rawParams) {
      const parsed = sessionAdoptParamsSchema.safeParse(rawParams)
      if (!parsed.success) throw invalidParams('The session adoption parameters are invalid.')
      try {
        return await options.repository.adopt(parsed.data as SessionAdoptParams, {
          allowedSourceRoots: options.allowedSourceRoots,
          ...options.migrationTestHooks,
          validateJournal
        })
      } catch (error) {
        if (error instanceof SessionWriterBusyError) {
          throw writerBusyProtocolError(error)
        }
        if (
          error instanceof Error &&
          /source|journal|migration|adopted session identity/i.test(error.message)
        ) {
          throw invalidParams('The source journal cannot be adopted.')
        }
        throw error
      }
    }
  }
}
