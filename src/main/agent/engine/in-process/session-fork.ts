import { dirname } from 'node:path'

import { FileSessionStorage, MemorySessionStorage, SessionManager } from '@oh-my-pi/pi-coding-agent'

import { isRecord, stringValue } from './common'
import { createSession } from './session-creation'
import { getSession } from './session-runtime'

export type SessionForkTarget = { kind: 'memory' } | { kind: 'persistent'; path: string }

/** Clone the current OMP history without moving or rewriting the source session. */
export async function cloneSessionManagerForFork(
  source: SessionManager,
  target: SessionForkTarget
): Promise<SessionManager> {
  if (target.kind === 'memory') {
    return source.persistCopy({ suppressBreadcrumb: true }, new MemorySessionStorage())
  }

  await source.ensureOnDisk()
  await source.flush()
  const sourcePath = source.getSessionFile()
  if (!sourcePath) throw new Error('The persistent fork source has no journal.')
  return SessionManager.forkFrom(
    sourcePath,
    source.getCwd(),
    dirname(target.path),
    new FileSessionStorage(),
    {
      sessionFile: target.path,
      suppressBreadcrumb: true
    }
  )
}

/** Internal worker operation. Public callers can only select the source in request context. */
export async function forkWorkerSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const sourceSessionId = stringValue(record.sourceSessionId)
  const targetSessionId = stringValue(record.targetSessionId)
  const agentDir = stringValue(record.agentDir)
  const create = isRecord(record.create) ? record.create : {}
  const managerInput = isRecord(record.sessionManager) ? record.sessionManager : {}
  const kind = stringValue(managerInput.kind)
  const target: SessionForkTarget =
    kind === 'memory'
      ? { kind: 'memory' }
      : { kind: 'persistent', path: stringValue(managerInput.path) }
  if (!sourceSessionId || !targetSessionId || !agentDir || !target.kind) {
    throw new Error('Invalid internal session fork request.')
  }
  if (target.kind === 'persistent' && !target.path) {
    throw new Error('Persistent session fork requires a target journal.')
  }

  const source = getSession(sourceSessionId).session.sessionManager
  const fork = await cloneSessionManagerForFork(source, target)
  try {
    return await createSession(
      {
        ...create,
        sessionId: targetSessionId,
        agentDir,
        sessionManager: managerInput
      },
      fork
    )
  } catch (error) {
    await fork.close().catch(() => undefined)
    throw error
  }
}
