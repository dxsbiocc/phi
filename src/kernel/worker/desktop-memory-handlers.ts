import type { JsonValue } from '../../shared/kernel-protocol'
import type { KernelMethodHandlers, KernelProtocolCore } from '../protocol'
import { makeProtocolError } from '../protocol/errors'
import type { PersistentSession } from '../sessions'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredSessionId(sessionId: string | undefined): string {
  if (!sessionId) throw makeProtocolError('INVALID_PARAMS', 'The request requires a sessionId.')
  return sessionId
}

export function createDesktopMemoryHandlers(options: {
  core(): KernelProtocolCore | undefined
  sessionCreateInputs: ReadonlyMap<string, Record<string, unknown>>
  persistentSession(sessionId: string): PersistentSession | undefined
  requireLoadedSession(sessionId: string): unknown
}): KernelMethodHandlers {
  const request = async (
    sessionId: string,
    capability: 'memory.read' | 'memory.deleteLesson' | 'memory.clear',
    params: Record<string, unknown> = {}
  ): Promise<unknown> => {
    options.requireLoadedSession(sessionId)
    const create = options.sessionCreateInputs.get(sessionId)
    const cwd = create && typeof create.cwd === 'string' ? create.cwd : undefined
    const core = options.core()
    if (!cwd || !core) {
      throw makeProtocolError('CAPABILITY_UNAVAILABLE', 'Project memory host is unavailable.', {
        reason: 'desktop_memory_unavailable'
      })
    }
    return core.requestHost(
      capability,
      { runtimeSessionId: sessionId, cwd, ...params },
      { sessionId }
    )
  }
  const snapshot = (value: unknown): JsonValue => {
    if (!isRecord(value) || !isRecord(value.snapshot)) {
      throw makeProtocolError('INTERNAL', 'Project memory host omitted its snapshot.')
    }
    return value.snapshot as JsonValue
  }
  return {
    async 'memory.read'(_params, _context, frame) {
      return snapshot(await request(requiredSessionId(frame.sessionId), 'memory.read'))
    },
    async 'memory.deleteLesson'(params, _context, frame) {
      return snapshot(
        await request(
          requiredSessionId(frame.sessionId),
          'memory.deleteLesson',
          isRecord(params) ? params : {}
        )
      )
    },
    async 'memory.clear'(_params, _context, frame) {
      await request(requiredSessionId(frame.sessionId), 'memory.clear')
      return { cleared: true }
    },
    async onRunCompleted(sessionId, runId, status) {
      if (status !== 'completed') return
      const create = options.sessionCreateInputs.get(sessionId)
      const memory = create && isRecord(create.memory) ? create.memory : undefined
      const cwd = create && typeof create.cwd === 'string' ? create.cwd : undefined
      const core = options.core()
      if (memory?.enabled !== true || !cwd || !core) return
      const persistent = options.persistentSession(sessionId)
      await core.requestHost(
        'memory.ingest',
        {
          runtimeSessionId: sessionId,
          cwd,
          runId,
          status: 'completed',
          source: {
            kind: persistent ? 'journal' : 'session',
            sessionId,
            ...(persistent ? { journalPath: persistent.journalPath } : {})
          }
        },
        { sessionId }
      )
    }
  }
}
