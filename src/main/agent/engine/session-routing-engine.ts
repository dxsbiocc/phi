import type { PhiAgentEvent } from './event-types'
import type { PhiEngine, PhiSessionCreateParams, WorkerSessionState } from './types'
import { findPhiSessionById, listPhiSessions } from '../session/session-store'
import { phiSessionIdFromPath } from '../session/sessions'
import { excludesManifestLocalJournalPath } from '../session/manifest-file'
import { RuntimeReferenceError } from '../session/runtime-reference'

export class RemoteSessionCapabilityError extends Error {
  constructor(readonly operation: string) {
    super(`远程会话尚未实现 ${operation}；当前操作已停止`)
    this.name = 'RemoteSessionCapabilityError'
  }
}
export interface RoutedSessionDriver {
  readonly isLive: boolean
  state(): WorkerSessionState
  prompt(text: string, options?: Record<string, unknown>): Promise<WorkerSessionState>
  abort(): Promise<WorkerSessionState>
  dispose(): Promise<void>
}
export interface RoutedSessionSink {
  event(event: PhiAgentEvent): void
  state(state: WorkerSessionState): void
}
/** Privileged main-process factory. Renderer create parameters do not select execution authority. */
export interface RoutedSessionFactory {
  create(
    params: PhiSessionCreateParams,
    signal: AbortSignal,
    sink: RoutedSessionSink
  ): Promise<RoutedSessionDriver>
}
interface Owner {
  readonly phiSessionId: string
  readonly controller: AbortController
  driver?: RoutedSessionDriver
  pending?: Promise<RoutedSessionDriver>
  retired: boolean
}
function observe<T>(listeners: Set<(value: T) => void> | undefined, value: T): void {
  for (const listener of listeners ?? []) {
    try {
      listener(value)
    } catch {
      /* One UI observer cannot change session authority. */
    }
  }
}

/** Routes owned sessions; every global delegate remains the genuine legacy implementation. */
export class SessionRoutingEngine implements PhiEngine {
  private readonly owners = new Map<string, Owner>()
  private readonly eventsById = new Map<string, Set<(event: PhiAgentEvent) => void>>()
  private readonly statesById = new Map<string, Set<(state: unknown) => void>>()
  readonly models: PhiEngine['models']
  readonly resources: PhiEngine['resources']
  readonly mcp: PhiEngine['mcp']
  readonly memory: PhiEngine['memory']
  readonly settings: PhiEngine['settings']
  readonly host: PhiEngine['host']
  constructor(
    private readonly legacy: PhiEngine,
    private readonly factory: () => RoutedSessionFactory | undefined
  ) {
    this.models = legacy.models
    this.resources = legacy.resources
    this.mcp = legacy.mcp
    this.memory = legacy.memory
    this.settings = legacy.settings
    this.host = legacy.host
  }
  owns(sessionId: string): boolean {
    return this.owners.has(sessionId)
  }
  private owned(sessionId: string): Owner | undefined {
    return this.owners.get(sessionId)
  }
  private driver(sessionId: string): RoutedSessionDriver {
    const owner = this.owned(sessionId)
    if (!owner?.driver || owner.retired)
      throw new RuntimeReferenceError('REMOTE_OPERATION_REQUIRED', '远程会话已中断，需要显式恢复')
    return owner.driver
  }
  private unsupported(sessionId: string, operation: string): void {
    if (this.owns(sessionId)) throw new RemoteSessionCapabilityError(operation)
  }
  private historyGuard(path?: string, cwd?: string): void {
    const phiId = path ? phiSessionIdFromPath(path) : null
    const manifests = phiId ? [findPhiSessionById(phiId)] : listPhiSessions()
    if (
      manifests.some(
        (manifest) =>
          manifest &&
          (manifest.runtimeRef || manifest.runtimeRecoveryError) &&
          (phiId ||
            (path &&
              (excludesManifestLocalJournalPath(manifest, path) ||
                (manifest.runtimeRecoveryError && manifest.runtimeSessionPath === path))) ||
            (cwd && manifest.cwd === cwd))
      )
    )
      throw new RemoteSessionCapabilityError('history')
  }
  private sessionScopeGuard(sessionId: string, operation: string): void {
    if (
      this.owns(sessionId) ||
      [...this.owners.values()].some((owner) => owner.phiSessionId === sessionId)
    )
      throw new RemoteSessionCapabilityError(operation)
  }
  readonly sessions: PhiEngine['sessions'] = {
    create: async (params) => {
      if (this.owns(params.sessionId))
        throw new RuntimeReferenceError(
          'STALE_GENERATION',
          '运行会话标识已被使用；恢复必须创建新的运行代次'
        )
      const manifest = params.remoteProject
        ? findPhiSessionById(params.remoteProject.phiSessionId)
        : undefined
      const factory = this.factory()
      if (!params.remoteProject || !factory) {
        if (manifest) {
          if (manifest.runtimeRecoveryError)
            throw new RuntimeReferenceError(
              manifest.runtimeRecoveryError.code,
              manifest.runtimeRecoveryError.message
            )
          if (manifest.runtimeRef)
            throw new RuntimeReferenceError(
              'REMOTE_OPERATION_REQUIRED',
              '远程会话需要显式启用已验证的远程恢复'
            )
        }
        // A public Phi locator never becomes a desktop SessionManager path.
        this.historyGuard(params.sessionManager.path, params.cwd)
        return this.legacy.sessions.create(params)
      }
      const phiSessionId = params.remoteProject.phiSessionId
      params = structuredClone(params)
      const owner: Owner = {
        phiSessionId,
        controller: new AbortController(),
        retired: false
      }
      this.owners.set(params.sessionId, owner)
      const live = (): boolean =>
        this.owners.get(params.sessionId) === owner &&
        !owner.retired &&
        !owner.controller.signal.aborted
      const sink: RoutedSessionSink = {
        event: (event) => {
          if (live()) observe(this.eventsById.get(params.sessionId), event)
        },
        state: (state) => {
          if (live()) observe(this.statesById.get(params.sessionId), state)
        }
      }
      try {
        owner.pending = Promise.resolve().then(() => {
          owner.controller.signal.throwIfAborted()
          return factory.create(params, owner.controller.signal, sink)
        })
        const driver = await owner.pending
        if (!live()) {
          await driver.dispose()
          throw new RuntimeReferenceError('CANCELLED', '远程会话创建已取消')
        }
        owner.driver = driver
        const state = driver.state()
        sink.state(state)
        return { sessionId: params.sessionId, state }
      } catch (error) {
        owner.retired = true
        owner.controller.abort(error)
        await owner.driver?.dispose().catch(() => undefined)
        throw error
      } finally {
        owner.pending = undefined
      }
    },
    prompt: async (params) =>
      this.owns(params.sessionId)
        ? this.driver(params.sessionId).prompt(params.text, params.options)
        : this.legacy.sessions.prompt(params),
    abort: async (params) => {
      const owner = this.owned(params.sessionId)
      if (!owner) return this.legacy.sessions.abort(params)
      if (!owner.driver) {
        owner.retired = true
        owner.controller.abort(new Error('Remote initialization stopped'))
        await owner.pending?.catch(() => undefined)
        throw new RuntimeReferenceError('CANCELLED', '远程初始化已停止')
      }
      return owner.driver.abort()
    },
    dispose: async (params) => {
      const owner = this.owned(params.sessionId)
      if (!owner) return this.legacy.sessions.dispose(params)
      owner.retired = true
      try {
        if (!owner.driver) owner.controller.abort(new Error('Remote initialization disposed'))
        await owner.driver?.dispose()
        await owner.pending?.then(
          (driver) => driver.dispose(),
          () => undefined
        )
      } finally {
        owner.controller.abort(new Error('Remote session disposed'))
      }
      return undefined
    },
    has: (sessionId) => {
      const owner = this.owned(sessionId)
      return owner
        ? !owner.retired && owner.driver?.isLive === true
        : this.legacy.sessions.has(sessionId)
    },
    setModel: async (params) => {
      this.unsupported(params.sessionId, 'setModel')
      return this.legacy.sessions.setModel(params)
    },
    setThinkingLevel: async (params) => {
      this.unsupported(params.sessionId, 'setThinkingLevel')
      return this.legacy.sessions.setThinkingLevel(params)
    },
    rename: async (params) => {
      this.unsupported(params.sessionId, 'rename')
      return this.legacy.sessions.rename(params)
    },
    contextUsage: async (params) => {
      this.unsupported(params.sessionId, 'contextUsage')
      return this.legacy.sessions.contextUsage(params)
    },
    compact: async (params) => {
      this.unsupported(params.sessionId, 'compact')
      return this.legacy.sessions.compact(params)
    },
    setAutoCompactionSettings: async (params) => {
      this.unsupported(params.sessionId, 'setAutoCompactionSettings')
      return this.legacy.sessions.setAutoCompactionSettings(params)
    },
    enterPlanMode: async (params) => {
      this.unsupported(params.sessionId, 'enterPlanMode')
      return this.legacy.sessions.enterPlanMode(params)
    }
  }
  readonly history: PhiEngine['history'] = {
    list: async (params) => {
      this.historyGuard(undefined, params.cwd)
      return this.legacy.history.list(params)
    },
    open: async (params) => {
      this.historyGuard(params.path, params.cwd)
      return this.legacy.history.open(params)
    },
    fork: async (params) => {
      this.historyGuard(params.path, params.cwd)
      return this.legacy.history.fork(params)
    },
    rename: async (params) => {
      this.historyGuard(params.path)
      return this.legacy.history.rename(params)
    }
  }
  readonly events: PhiEngine['events'] = {
    onSessionEvent: (id, listener) => {
      const entries = this.eventsById.get(id) ?? new Set()
      this.eventsById.set(id, entries)
      entries.add(listener)
      const detach = this.legacy.events.onSessionEvent(id, (event) => {
        if (!this.owns(id)) listener(event)
      })
      return () => {
        entries.delete(listener)
        if (!entries.size) this.eventsById.delete(id)
        detach()
      }
    },
    onSessionState: (id, listener) => {
      const entries = this.statesById.get(id) ?? new Set()
      this.statesById.set(id, entries)
      entries.add(listener)
      const detach = this.legacy.events.onSessionState(id, (state) => {
        if (!this.owns(id)) listener(state)
      })
      return () => {
        entries.delete(listener)
        if (!entries.size) this.statesById.delete(id)
        detach()
      }
    },
    onToolApproval: (id, listener) =>
      this.legacy.events.onToolApproval(id, (request) => {
        if (!this.owns(id)) listener(request)
      }),
    // Remote approval is awaited by the trusted existing UI callback, not a second dialog.
    respondToolApproval: (id, result) => this.legacy.events.respondToolApproval(id, result)
  }
  readonly agentRuns: PhiEngine['agentRuns'] = {
    list: async (params) => this.legacy.agentRuns.list(params),
    steer: async (params) => {
      this.sessionScopeGuard(params.sessionId, 'agentRuns.steer')
      return this.legacy.agentRuns.steer(params)
    },
    stop: (params) => {
      this.sessionScopeGuard(params.sessionId, 'agentRuns.stop')
      return this.legacy.agentRuns.stop(params)
    }
  }
  readonly shellJobs: PhiEngine['shellJobs'] = {
    list: async (params) => this.legacy.shellJobs.list(params),
    cancel: async (params) => {
      this.sessionScopeGuard(params.sessionId, 'shellJobs.cancel')
      return this.legacy.shellJobs.cancel(params)
    }
  }
  async stop(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.owners.keys()]
        .map((sessionId) => this.sessions.dispose({ sessionId }))
        .concat(this.legacy.stop())
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
