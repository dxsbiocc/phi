import { randomUUID } from 'node:crypto'
import type { ProjectMemorySettings } from '../../../../shared/projectMemoryTypes'
import { normalizeProjectMemorySettings } from '../../../../shared/projectMemoryTypes'
import { buildProjectLearnTool } from '../../memory/learn-tool'
import { getOmpBridge, type OmpBridge } from '../omp-bridge'
import type { PhiTool } from '../types'
import type { RemoteRuntimeSnapshot } from './remote-session-runtime'
import { rpcIdentifier } from './control-frame'
import { webSearchPath, webSearchRecord } from './desktop-websearch-protocol'

export interface DesktopProjectMemoryOptions {
  identity: { runtimeSessionId: string; sessionId: string; projectId: string; cwd: string }
  agentDir: string
  resourceCwd: string
  settings: ProjectMemorySettings
  signal?: AbortSignal
  beforeDispatch?: () => void
  bridge?: Pick<OmpBridge, 'request' | 'retainResourceWorker'>
}
export interface DesktopProjectMemoryAdapter {
  readonly identity: Readonly<DesktopProjectMemoryOptions['identity']>
  readonly memoryBlock?: string
  readonly tools: readonly PhiTool[]
  ingest(input: {
    runId: string
    snapshot: RemoteRuntimeSnapshot
    outcome: 'completed' | 'aborted' | 'error'
    signal: AbortSignal
  }): Promise<void>
  retire(): void
  close(): Promise<void>
}
const branded = new WeakSet<object>()
const projects = new Map<string, Set<DesktopProjectMemoryAdapter>>()
const projectEpochs = new Map<string, number>()
const retiringProjects = new Map<string, number>()
export function isDesktopProjectMemoryAdapter(value: object): value is DesktopProjectMemoryAdapter {
  return branded.has(value)
}

/** Main policy changes invalidate outstanding writers before UI mutation or resource rebinding. */
export async function retireDesktopProjectMemoryAdapters(projectId: string): Promise<void> {
  projectEpochs.set(projectId, (projectEpochs.get(projectId) ?? 0) + 1)
  retiringProjects.set(projectId, (retiringProjects.get(projectId) ?? 0) + 1)
  try {
    while (projects.get(projectId)?.size) {
      const owned = [...projects.get(projectId)!]
      for (const adapter of owned) adapter.retire()
      const results = await Promise.allSettled(owned.map((adapter) => adapter.close()))
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  } finally {
    const remaining = (retiringProjects.get(projectId) ?? 1) - 1
    if (remaining === 0) retiringProjects.delete(projectId)
    else retiringProjects.set(projectId, remaining)
  }
}

/** Project memory remains on this computer; the RPC journal is imported only after verification. */
export async function createDesktopProjectMemoryAdapter(
  options: DesktopProjectMemoryOptions
): Promise<DesktopProjectMemoryAdapter> {
  const identity = Object.freeze({ ...options.identity })
  if (
    ![identity.runtimeSessionId, identity.sessionId, identity.projectId].every(rpcIdentifier) ||
    !webSearchPath(identity.cwd) ||
    !webSearchPath(options.agentDir) ||
    !webSearchPath(options.resourceCwd)
  )
    throw new Error('Project memory requires a trusted local anchor and session')
  if (retiringProjects.has(identity.projectId)) throw new Error('Project memory is being retired')
  const projectEpoch = projectEpochs.get(identity.projectId) ?? 0
  const policy = normalizeProjectMemorySettings(options.settings)
  options.beforeDispatch?.()
  const bridge = options.bridge ?? getOmpBridge()
  const worker = bridge.retainResourceWorker()
  const retirement = new AbortController()
  const lifetime = AbortSignal.any([
    retirement.signal,
    worker.signal,
    ...(options.signal ? [options.signal] : [])
  ])
  const scopeId = randomUUID()
  const active = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined
  const guard = (signal?: AbortSignal): void => {
    lifetime.throwIfAborted()
    if (
      retiringProjects.has(identity.projectId) ||
      (projectEpochs.get(identity.projectId) ?? 0) !== projectEpoch
    )
      throw new Error('Project memory policy generation changed')
    signal?.throwIfAborted()
    options.beforeDispatch?.()
  }
  const cancel = (requestId?: string): void => {
    if (!worker.signal.aborted)
      void bridge
        .request('memory.desktopCancel', { scopeId, ...(requestId ? { requestId } : {}) })
        .catch(() => {})
  }
  const aborted = (): void => cancel()
  lifetime.addEventListener('abort', aborted, { once: true })
  let adapter: DesktopProjectMemoryAdapter | undefined
  const close = (): Promise<void> => {
    retirement.abort(new Error('Project memory adapter retired'))
    return (closing ??= (async () => {
      try {
        if (!worker.signal.aborted) await bridge.request('memory.desktopClose', { scopeId })
        await Promise.allSettled([...active])
      } finally {
        lifetime.removeEventListener('abort', aborted)
        if (adapter) {
          const owned = projects.get(identity.projectId)
          owned?.delete(adapter)
          if (owned?.size === 0) projects.delete(identity.projectId)
        }
        worker.release()
      }
    })())
  }
  const call = async (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> => {
    guard(signal)
    const requestId = randomUUID()
    const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])])
    const abort = (): void => cancel(requestId)
    combined.addEventListener('abort', abort, { once: true })
    const operation = bridge.request(method, { scopeId, requestId, ...params })
    active.add(operation)
    try {
      const value = await operation
      guard(signal)
      return value
    } finally {
      active.delete(operation)
      combined.removeEventListener('abort', abort)
    }
  }
  try {
    guard()
    const creating = bridge.request<unknown>('memory.desktopCreate', {
      scopeId,
      identity,
      agentDir: options.agentDir,
      cwd: options.resourceCwd,
      policy
    })
    active.add(creating)
    let result: unknown
    try {
      result = await creating
    } finally {
      active.delete(creating)
    }
    guard()
    if (
      !webSearchRecord(result) ||
      (result.memoryBlock !== undefined && typeof result.memoryBlock !== 'string')
    )
      throw new Error('Project memory snapshot is invalid')
    const tools: PhiTool[] =
      policy.enabled && policy.learn
        ? [
            buildProjectLearnTool(async (input, signal) => {
              const value = await call('memory.desktopLearn', { input }, signal)
              if (!webSearchRecord(value) || typeof value.stored !== 'number')
                throw new Error('Project lesson was not confirmed')
              return { stored: value.stored }
            })
          ]
        : []
    adapter = Object.freeze({
      identity,
      ...(typeof result.memoryBlock === 'string' ? { memoryBlock: result.memoryBlock } : {}),
      tools: Object.freeze(tools),
      async ingest(input: Parameters<DesktopProjectMemoryAdapter['ingest']>[0]): Promise<void> {
        if (!policy.enabled || input.outcome !== 'completed' || lifetime.aborted) return
        guard(input.signal)
        const snapshot = input.snapshot
        if (
          !rpcIdentifier(input.runId) ||
          snapshot.checkpoint.phiSessionId !== identity.sessionId ||
          snapshot.checkpoint.projectRoot !== identity.cwd ||
          !Array.isArray(snapshot.messages)
        )
          throw new Error('Project memory requires a verified terminal snapshot')
        try {
          await call(
            'memory.desktopIngest',
            {
              source: {
                runId: input.runId,
                ompSessionId: snapshot.reference.ompSessionId,
                journalPath: snapshot.checkpoint.journalPath,
                leafId: snapshot.checkpoint.leafId,
                messageCount: snapshot.checkpoint.messageCount,
                messages: snapshot.messages,
                model: { provider: snapshot.model.provider, id: snapshot.model.id }
              }
            },
            input.signal
          )
        } catch {
          retirement.abort(new Error('Project memory ingestion retired'))
          throw new Error('Project memory ingestion was not accepted')
        }
      },
      retire: () => retirement.abort(new Error('Project memory adapter retired')),
      close
    })
    branded.add(adapter)
    const owned = projects.get(identity.projectId) ?? new Set<DesktopProjectMemoryAdapter>()
    owned.add(adapter)
    projects.set(identity.projectId, owned)
    return adapter
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
