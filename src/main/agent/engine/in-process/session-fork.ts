import { dirname } from 'node:path'

import { FileSessionStorage, MemorySessionStorage, SessionManager } from '@oh-my-pi/pi-coding-agent'

import { sessionForkCutSchema, type SessionForkCut } from '../../../../shared/kernel-protocol'
import { isRecord, stringValue } from './common'
import { createSession } from './session-creation'
import { userMessageText } from './session-history'
import { getSession } from './session-runtime'
import type { KernelRuntimeServices } from './kernel-services'

export type SessionForkTarget = { kind: 'memory' } | { kind: 'persistent'; path: string }

function selectedForkLeaf(source: SessionManager, cut: SessionForkCut): string {
  const branch = source.getBranch()
  let searchFrom = 0
  const matched: number[] = []
  for (const text of cut.userMessages) {
    const index = branch.findIndex(
      (entry, index) =>
        index >= searchFrom && entry.type === 'message' && userMessageText(entry.message) === text
    )
    if (index < 0) throw new Error('会话历史与界面消息无法对应，请重新打开会话后重试')
    matched.push(index)
    searchFrom = index + 1
  }
  const nextUserIndex = matched[cut.selectedIndex + 1]
  const leaf = branch[(nextUserIndex ?? branch.length) - 1]
  if (!leaf) throw new Error('无法定位会话分叉点')
  return leaf.id
}

async function cloneSelectedBranch(
  source: SessionManager,
  target: SessionForkTarget,
  leafId: string
): Promise<SessionManager> {
  const branch = await source.persistCopy({ suppressBreadcrumb: true }, new MemorySessionStorage())
  branch.createBranchedSession(leafId)
  if (target.kind === 'memory') return branch

  const persistent = await SessionManager.open(
    target.path,
    dirname(target.path),
    new FileSessionStorage(),
    { initialCwd: source.getCwd(), suppressBreadcrumb: true }
  )
  try {
    for (const entry of branch.getBranch()) {
      persistent.ingestReplicatedEntry(structuredClone(entry))
    }
    await persistent.flush()
    return persistent
  } catch (error) {
    await persistent.close().catch(() => undefined)
    throw error
  } finally {
    await branch.close().catch(() => undefined)
  }
}

/** Clone the current OMP history without moving or rewriting the source session. */
export async function cloneSessionManagerForFork(
  source: SessionManager,
  target: SessionForkTarget,
  cut?: SessionForkCut
): Promise<SessionManager> {
  if (cut) return cloneSelectedBranch(source, target, selectedForkLeaf(source, cut))
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
export async function forkWorkerSession(
  params: unknown,
  kernelServices?: KernelRuntimeServices
): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const sourceSessionId = stringValue(record.sourceSessionId)
  const targetSessionId = stringValue(record.targetSessionId)
  const agentDir = stringValue(record.agentDir)
  const create = isRecord(record.create) ? record.create : {}
  const managerInput = isRecord(record.sessionManager) ? record.sessionManager : {}
  const cut = record.cut === undefined ? undefined : sessionForkCutSchema.parse(record.cut)
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
  const fork = await cloneSessionManagerForFork(source, target, cut)
  try {
    return await createSession(
      {
        ...create,
        sessionId: targetSessionId,
        agentDir,
        sessionManager: managerInput
      },
      { preparedSessionManager: fork, ...(kernelServices ? { kernelServices } : {}) }
    )
  } catch (error) {
    await fork.close().catch(() => undefined)
    throw error
  }
}
