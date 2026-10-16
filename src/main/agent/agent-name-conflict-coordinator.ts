import { createHash } from 'node:crypto'

import type {
  AgentNameConflictChoice,
  AgentNameConflictNotice
} from '../../shared/agentNameConflictTypes'
import type { PhiAgentDefinition } from './agents/definition'
import { writeAppLog } from './app-logger'
import { getProject, updateProjectRpcAgentAliases } from './projects'
import {
  resolveRemoteWorkspaceHostBinding,
  type RemoteWorkspaceHostBinding
} from './remote-workspace-boundary'
import { findPhiSessionById, updateSessionManifest } from './session/session-store'
import { renameDetectedOmpAgent } from './engine/rpc/subagents/agent-conflict-remote'
import {
  scanRpcAgentConflicts,
  type RpcAgentConflictRecord,
  type RpcAgentConflictScan
} from './engine/rpc/subagents/agent-conflicts'
import { snapshotBinding } from './engine/rpc/subagents/definition-validation'
import type { RpcAgentServerBinding } from './engine/rpc/subagents/types'

interface StoredConflict {
  readonly record: RpcAgentConflictRecord
  readonly bindingCacheKey: string
}

export interface AgentNameConflictInspection {
  readonly aliases: Readonly<Record<string, string>>
  readonly blockedAgents: RpcAgentConflictScan['blocked']
  readonly conflicts: readonly AgentNameConflictNotice[]
}

interface CoordinatorDependencies {
  readonly resolveBinding?: typeof resolveRemoteWorkspaceHostBinding
  readonly getProject?: typeof getProject
  readonly getSession?: typeof findPhiSessionById
  readonly updateAliases?: typeof updateProjectRpcAgentAliases
  readonly updateSession?: typeof updateSessionManifest
  readonly audit?: typeof writeAppLog
}

function serverBinding(binding: RemoteWorkspaceHostBinding): RpcAgentServerBinding {
  const cacheIdentity: unknown = JSON.parse(binding.cacheKey)
  if (!Array.isArray(cacheIdentity) || typeof cacheIdentity[0] !== 'string') {
    throw new Error('RPC agent conflict host binding is invalid')
  }
  return snapshotBinding({
    serverId: cacheIdentity[0],
    serverIdentitySha256: createHash('sha256').update(binding.cacheKey).digest('hex'),
    projectId: binding.projectId,
    projectRoot: binding.canonicalRoot
  })
}

export class AgentNameConflictCoordinator {
  private readonly records = new Map<string, StoredConflict>()
  private readonly queue: string[] = []
  private readonly listeners = new Set<(notice: AgentNameConflictNotice | null) => void>()
  private readonly inspectionRevisions = new Map<string, number>()
  private readonly inlineSessions = new Map<string, number>()

  constructor(private readonly dependencies: CoordinatorDependencies = {}) {}

  pending(): AgentNameConflictNotice | null {
    while (this.queue.length) {
      const notice = this.records.get(this.queue[0])?.record.notice
      if (notice) return notice
      this.queue.shift()
    }
    return null
  }

  subscribe(listener: (notice: AgentNameConflictNotice | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Suppress only startup-dialog scans that overlap an active inline resolution loop. */
  beginInlineResolution(sessionId: string): () => void {
    const previous = this.inlineSessions.get(sessionId) ?? 0
    this.inlineSessions.set(sessionId, previous + 1)
    if (previous === 0) {
      let changed = false
      for (let index = this.queue.length - 1; index >= 0; index--) {
        const stored = this.records.get(this.queue[index])
        if (stored?.record.notice.sessionId !== sessionId) continue
        this.queue.splice(index, 1)
        changed = true
      }
      if (changed) this.notify()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.inlineSessions.get(sessionId) ?? 1) - 1
      if (remaining > 0) this.inlineSessions.set(sessionId, remaining)
      else this.inlineSessions.delete(sessionId)
    }
  }

  private notify(): void {
    const current = this.pending()
    for (const listener of this.listeners) listener(current)
  }

  private resolveBinding(sessionId: string, projectId: string): RemoteWorkspaceHostBinding {
    return (this.dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
      sessionId,
      projectId
    })
  }

  async inspect(options: {
    readonly sessionId: string
    readonly projectId: string
    readonly definitions: readonly PhiAgentDefinition[]
    readonly enqueueDialogs: boolean
    readonly signal?: AbortSignal
  }): Promise<AgentNameConflictInspection> {
    options.signal?.throwIfAborted()
    const revision = (this.inspectionRevisions.get(options.sessionId) ?? 0) + 1
    this.inspectionRevisions.set(options.sessionId, revision)
    const project = (this.dependencies.getProject ?? getProject)(options.projectId)
    const manifest = (this.dependencies.getSession ?? findPhiSessionById)(options.sessionId)
    if (
      !project ||
      project.location.kind !== 'ssh' ||
      !manifest ||
      manifest.projectId !== project.id ||
      manifest.projectLocation?.kind !== 'ssh'
    ) {
      throw new Error('RPC agent conflict inspection requires the selected SSH project session')
    }
    const binding = this.resolveBinding(options.sessionId, options.projectId)
    const session = await binding.config.connect()
    let scan: RpcAgentConflictScan
    try {
      options.signal?.throwIfAborted()
      scan = await scanRpcAgentConflicts({
        session,
        sessionId: options.sessionId,
        projectId: options.projectId,
        hostAlias: binding.hostAlias,
        projectRoot: binding.canonicalRoot,
        binding: serverBinding(binding),
        definitions: options.definitions,
        aliases: project.rpcAgentAliases,
        deferrals: manifest.rpcAgentConflictDeferrals
      })
      options.signal?.throwIfAborted()
    } finally {
      await session.close().catch(() => undefined)
    }
    const inspection = Object.freeze({
      aliases: Object.freeze({ ...(project.rpcAgentAliases ?? {}) }),
      blockedAgents: scan.blocked,
      conflicts: Object.freeze(scan.conflicts.map((conflict) => conflict.notice))
    })
    if (this.inspectionRevisions.get(options.sessionId) !== revision) return inspection
    const activeIds = new Set(scan.conflicts.map((conflict) => conflict.notice.id))
    for (const [id, stored] of this.records) {
      if (
        stored.record.notice.sessionId === options.sessionId &&
        stored.record.notice.projectId === options.projectId &&
        !activeIds.has(id)
      ) {
        this.records.delete(id)
      }
    }
    for (const conflict of scan.conflicts) {
      this.records.set(conflict.notice.id, {
        record: conflict,
        bindingCacheKey: binding.cacheKey
      })
      if (
        options.enqueueDialogs &&
        !this.inlineSessions.has(options.sessionId) &&
        !this.queue.includes(conflict.notice.id)
      ) {
        this.queue.push(conflict.notice.id)
      }
    }
    if (scan.verificationError) {
      const audit = this.dependencies.audit ?? writeAppLog
      audit({
        level: 'warn',
        event: 'rpc_agent_conflict_check_failed',
        sessionId: options.sessionId,
        metadata: { projectId: options.projectId, reason: scan.verificationError }
      })
    }
    if (!options.enqueueDialogs) {
      for (let index = this.queue.length - 1; index >= 0; index--) {
        const stored = this.records.get(this.queue[index])
        if (stored?.record.notice.sessionId === options.sessionId) this.queue.splice(index, 1)
      }
    }
    this.notify()
    return inspection
  }

  async resolve(id: string, choice: AgentNameConflictChoice): Promise<void> {
    const stored = this.records.get(id)
    if (!stored) throw new Error('Agent conflict request is no longer current')
    const { record } = stored
    const { notice, detection, profile } = record
    const project = (this.dependencies.getProject ?? getProject)(notice.projectId)
    const manifest = (this.dependencies.getSession ?? findPhiSessionById)(notice.sessionId)
    const binding = this.resolveBinding(notice.sessionId, notice.projectId)
    if (
      !project ||
      project.location.kind !== 'ssh' ||
      !manifest ||
      manifest.projectId !== project.id ||
      binding.cacheKey !== stored.bindingCacheKey
    ) {
      throw new Error('Agent conflict project or connection changed; detect again')
    }
    if (choice === 'rename_phi') {
      const update = this.dependencies.updateAliases ?? updateProjectRpcAgentAliases
      update(project.id, {
        ...(project.rpcAgentAliases ?? {}),
        [profile.sourceName]: notice.proposedPhiName
      })
    } else if (choice === 'rename_other') {
      const session = await binding.config.connect()
      try {
        await renameDetectedOmpAgent(session, detection, notice.proposedOtherName)
      } finally {
        await session.close().catch(() => undefined)
      }
      const audit = this.dependencies.audit ?? writeAppLog
      audit({
        event: 'rpc_agent_conflict_renamed',
        sessionId: notice.sessionId,
        metadata: {
          projectId: notice.projectId,
          hostAlias: notice.hostAlias,
          filePath: notice.filePath,
          previousName: notice.requestedName,
          nextName: notice.proposedOtherName,
          detectedHash: detection.contentHash
        }
      })
    } else if (choice === 'not_now') {
      const update = this.dependencies.updateSession ?? updateSessionManifest
      update(notice.sessionId, {
        rpcAgentConflictDeferrals: {
          ...(manifest.rpcAgentConflictDeferrals ?? {}),
          [profile.sourceName]: {
            filePath: detection.filePath,
            contentHash: detection.contentHash,
            name: detection.name
          }
        }
      })
    } else {
      throw new Error('Invalid agent conflict decision')
    }
    this.records.delete(id)
    const index = this.queue.indexOf(id)
    if (index >= 0) this.queue.splice(index, 1)
    this.notify()
  }
}
