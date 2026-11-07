import type { ContextUsageSnapshot } from '../../../shared/contextUsageTypes'
import type { PlanRunReplanRequest, PlanRunState } from '../../../shared/planRunTypes'
import type {
  AutoCompactionDefaults,
  AutoCompactionOverrides,
  ContextCompactionSummary
} from '../../../shared/contextUsageTypes'
import type { PhiAgentEvent } from './event-types'
import type {
  PhiEngine,
  PhiHistoryForkParams,
  PhiHistoryForkResult,
  PhiSessionCreateParams,
  WorkerSessionState,
  RuntimeModel,
  RuntimeSelectionControl,
  ThinkingLevel
} from './types'
import type { RuntimeAutoCompactionReceipt } from './types'
import {
  findPhiSessionById,
  listPhiSessions,
  updateSessionManifest
} from '../session/session-store'
import { phiSessionIdFromPath } from '../session/sessions'
import { excludesManifestLocalJournalPath } from '../session/manifest-file'
import { RuntimeReferenceError } from '../session/runtime-reference'
import { createRoutedSink, RoutedHostRegistry } from './routed-host-registry'

export class RemoteSessionCapabilityError extends Error {
  constructor(readonly operation: string) {
    super(`远程会话尚未实现 ${operation}；当前操作已停止`)
    this.name = 'RemoteSessionCapabilityError'
  }
}

export interface RoutedPlanRunOperations {
  list(): Promise<PlanRunState[]>
  get(runId: string): Promise<PlanRunState | null>
  stop(runId: string): Promise<PlanRunState>
  retryStep(runId: string, stepId: string): Promise<PlanRunState>
  skipStep(runId: string, stepId: string): Promise<PlanRunState>
  requestReplan(runId: string): Promise<PlanRunReplanRequest>
}

export interface RoutedSessionDriver {
  hasActiveAgentRuns?(): boolean
  readonly agentRuns?: {
    start?(params: { agent?: string; task: string; requestId: string }): Promise<{ runId: string }>
    list(): readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>
    resourceOwner(runId: string): {
      readonly toolOwner: string
      readonly allowedSkills: readonly string[]
    }
    steer(runId: string, message: string): Promise<void>
    stop(runId: string): Promise<unknown>
    wait(options: {
      ids?: readonly string[]
      mode?: 'all' | 'any'
      timeoutMs?: number
      signal?: AbortSignal
    }): Promise<unknown>
  }
  readonly shellJobs?: {
    list(): readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>
    cancel(jobId: string): Promise<{ ok?: boolean }>
  }
  readonly planRuns?: RoutedPlanRunOperations
  autoCompactionSettings?(control?: RuntimeSelectionControl): Promise<RuntimeAutoCompactionReceipt>
  compact?(
    control?: RuntimeSelectionControl
  ): Promise<{ summary: ContextCompactionSummary; state: WorkerSessionState }>
  setAutoCompactionSettings?(
    overrides: AutoCompactionOverrides,
    control?: RuntimeSelectionControl
  ): Promise<AutoCompactionDefaults>
  readonly isLive: boolean
  interruption?(): Error | undefined
  state(): WorkerSessionState
  prompt(text: string, options?: Record<string, unknown>): Promise<WorkerSessionState>
  contextUsage(): Promise<ContextUsageSnapshot | null>
  rename(name: string, control?: RuntimeSelectionControl): Promise<WorkerSessionState>
  setModel?(model: RuntimeModel, control?: RuntimeSelectionControl): Promise<WorkerSessionState>
  setThinkingLevel?(
    level: ThinkingLevel | undefined,
    control?: RuntimeSelectionControl
  ): Promise<WorkerSessionState>
  enterPlanMode?(execute?: boolean): Promise<unknown>
  cancelPlanMode?(replanRequestId?: string): Promise<boolean>
  respondToolApproval?(requestId: string, result: unknown): Promise<void>
  abort(): Promise<WorkerSessionState>
  dispose(): Promise<void>
}
export interface RoutedSessionSink {
  event(event: PhiAgentEvent): void
  state(state: WorkerSessionState): void
  approval?(request: unknown): void
}
/** Privileged main-process factory. Renderer create parameters do not select execution authority. */
export interface RoutedSessionFactory {
  handles?(params: PhiSessionCreateParams): boolean
  registerHostHandler?(method: string, handler: import('./types').PhiHostRequestHandler): () => void
  stop?(): Promise<void>
  historyOpen?(params: {
    agentDir: string
    path: string
    cwd?: string
  }): Promise<{ cwd?: string; sessionFile?: string } | undefined>
  historyFork?(params: PhiHistoryForkParams): Promise<PhiHistoryForkResult | undefined>
  discardHistoryFork?(result: PhiHistoryForkResult): Promise<boolean>
  create(
    params: PhiSessionCreateParams,
    signal: AbortSignal,
    sink: RoutedSessionSink,
    control?: RuntimeSelectionControl
  ): Promise<RoutedSessionDriver>
}
interface Owner {
  readonly phiSessionId: string
  readonly projectId: string
  readonly params: PhiSessionCreateParams
  readonly controller: AbortController
  driver?: RoutedSessionDriver
  pending?: Promise<RoutedSessionDriver>
  retired: boolean
}
/** Routes main sessions through the kernel while retaining explicit auxiliary no-tools calls. */
export class SessionRoutingEngine implements PhiEngine {
  private readonly owners = new Map<string, Owner>()
  private readonly eventsById = new Map<string, Set<(event: PhiAgentEvent) => void>>()
  private readonly statesById = new Map<string, Set<(state: unknown) => void>>()
  private readonly approvalsById = new Map<string, Set<(request: unknown) => void>>()
  private readonly approvalOwners = new Map<string, string>()
  private readonly hostRegistry: RoutedHostRegistry
  readonly models: PhiEngine['models']
  readonly decisions: PhiEngine['decisions']
  readonly resources: PhiEngine['resources']
  readonly mcp: PhiEngine['mcp']
  readonly memory: PhiEngine['memory']
  readonly settings: PhiEngine['settings']
  readonly host: PhiEngine['host']
  constructor(
    private readonly legacy: PhiEngine,
    private readonly factory: () => RoutedSessionFactory | undefined,
    private readonly options: {
      readonly remotePlanExecutionEnabled?: boolean | ((projectId: string) => boolean)
    } = {}
  ) {
    this.models = legacy.models
    this.decisions = legacy.decisions
    this.resources = legacy.resources
    this.mcp = legacy.mcp
    this.memory = legacy.memory
    this.settings = legacy.settings
    this.hostRegistry = new RoutedHostRegistry(legacy.host, this.factory)
    this.host = this.hostRegistry.host
    this.hostRegistry.registerRouted('decisions.evaluate', (params, context) => {
      const input = params as {
        runtimeSessionId?: unknown
        model?: unknown
        request?: unknown
      }
      const sessionId =
        context.originSessionId ??
        (typeof input.runtimeSessionId === 'string' ? input.runtimeSessionId : undefined)
      const owner = sessionId ? this.owned(sessionId) : undefined
      if (!sessionId || !owner || !input.model || !input.request) {
        throw new Error('Routed decision session is unavailable')
      }
      return this.legacy.decisions.evaluate(
        {
          agentDir: owner.params.agentDir,
          sessionId,
          model: input.model as Parameters<PhiEngine['decisions']['evaluate']>[0]['model'],
          request: input.request as Parameters<PhiEngine['decisions']['evaluate']>[0]['request']
        },
        context.signal
      )
    })
  }
  ownsPhi(phiSessionId: string): boolean {
    return [...this.owners.values()].some((owner) => owner.phiSessionId === phiSessionId)
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
  private historyGuard(path?: string, cwd?: string): void {
    const phiId = path ? phiSessionIdFromPath(path) : null
    const manifests = phiId ? [findPhiSessionById(phiId)] : listPhiSessions()
    const guarded = manifests.find(
      (manifest) =>
        manifest &&
        (manifest.projectLocation?.kind === 'ssh' ||
          manifest.runtimeRef ||
          manifest.kernelRuntimeRef ||
          manifest.runtimeRecoveryError) &&
        (phiId ||
          (path &&
            (excludesManifestLocalJournalPath(manifest, path) ||
              (manifest.runtimeRecoveryError && manifest.runtimeSessionPath === path))) ||
          (cwd && manifest.cwd === cwd))
    )
    if (guarded?.kernelRuntimeRef) {
      throw new RuntimeReferenceError(
        'REMOTE_OPERATION_REQUIRED',
        'This chat belongs to the Phi kernel. Re-enable the kernel route to continue, or roll back to a verified legacy package before opening it there.'
      )
    }
    if (guarded) throw new RemoteSessionCapabilityError('history')
  }
  private createAuxiliarySession(
    params: PhiSessionCreateParams,
    control: RuntimeSelectionControl | undefined
  ): ReturnType<PhiEngine['sessions']['create']> {
    if (!params.noTools || params.phiSessionId || params.remoteProject) {
      throw new RuntimeReferenceError(
        'REMOTE_OPERATION_REQUIRED',
        'Desktop execution is limited to independent no-tools helpers.'
      )
    }
    return this.legacy.sessions.create(params, control)
  }

  private async createRoutedSession(
    input: PhiSessionCreateParams,
    control: RuntimeSelectionControl | undefined,
    factory: RoutedSessionFactory
  ): Promise<import('./types').WorkerCreateSessionResult> {
    this.hostRegistry.sync(factory)
    const params = structuredClone(input)
    const owner: Owner = {
      phiSessionId: params.remoteProject?.phiSessionId ?? params.phiSessionId ?? params.sessionId,
      projectId: params.remoteProject?.projectId ?? '',
      params,
      controller: new AbortController(),
      retired: false
    }
    this.owners.set(params.sessionId, owner)
    const abortPreparation = (): void => owner.controller.abort(control?.signal?.reason)
    control?.signal?.addEventListener('abort', abortPreparation, { once: true })
    if (control?.signal?.aborted) abortPreparation()
    const live = (): boolean =>
      this.owners.get(params.sessionId) === owner &&
      !owner.retired &&
      !owner.controller.signal.aborted
    const sink = createRoutedSink({
      params,
      live,
      events: this.eventsById,
      states: this.statesById,
      approvals: this.approvalsById,
      approvalOwners: this.approvalOwners
    })
    try {
      owner.pending = Promise.resolve().then(() => {
        owner.controller.signal.throwIfAborted()
        control?.assertCurrent()
        return factory.create(params, owner.controller.signal, sink, control)
      })
      const driver = await owner.pending
      if (!live()) {
        await driver.dispose()
        throw new RuntimeReferenceError('CANCELLED', '远程会话创建已取消')
      }
      owner.driver = driver
      control?.assertCurrent()
      const state = driver.state()
      sink.state(state)
      return { sessionId: params.sessionId, state }
    } catch (error) {
      owner.retired = true
      owner.controller.abort(error)
      await owner.driver?.dispose().catch(() => undefined)
      throw error
    } finally {
      control?.signal?.removeEventListener('abort', abortPreparation)
      owner.pending = undefined
    }
  }

  readonly sessions: PhiEngine['sessions'] = {
    autoCompactionSettings: async (params, control) => {
      const owner = this.owned(params.sessionId)
      if (owner) {
        const driver = this.driver(params.sessionId)
        if (!driver.autoCompactionSettings)
          throw new RemoteSessionCapabilityError('auto compaction settings')
        return driver.autoCompactionSettings(control)
      }
      if (!this.legacy.sessions.autoCompactionSettings)
        throw new Error('Live compaction settings are unavailable')
      return this.legacy.sessions.autoCompactionSettings(params, control)
    },
    hasActiveAgentRuns: (id) => {
      const owner = this.owned(id)
      if (!owner || owner.retired) return false
      return owner.driver ? (owner.driver.hasActiveAgentRuns?.() ?? false) : !!owner.pending
    },
    create: async (params, control) => {
      control?.assertCurrent()
      control?.signal?.throwIfAborted()
      if (this.owns(params.sessionId))
        throw new RuntimeReferenceError(
          'STALE_GENERATION',
          '运行会话标识已被使用；恢复必须创建新的运行代次'
        )
      if (params.noTools && !params.phiSessionId && !params.remoteProject) {
        return this.createAuxiliarySession(params, control)
      }
      const factory = this.factory()
      if (!factory) {
        throw new RuntimeReferenceError(
          'REMOTE_OPERATION_REQUIRED',
          'The Phi kernel session route is unavailable.'
        )
      }
      return this.createRoutedSession(params, control, factory)
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
    interruption: (sessionId) => {
      const owner = this.owned(sessionId)
      return owner && !owner.retired ? owner.driver?.interruption?.() : undefined
    },
    setModel: async (params, control) => {
      if (this.owns(params.sessionId)) {
        const driver = this.driver(params.sessionId)
        if (!driver.setModel) throw new RemoteSessionCapabilityError('setModel')
        return driver.setModel(params.model, control)
      }
      return this.legacy.sessions.setModel(params)
    },
    setThinkingLevel: async (params, control) => {
      if (this.owns(params.sessionId)) {
        const driver = this.driver(params.sessionId)
        if (!driver.setThinkingLevel) throw new RemoteSessionCapabilityError('setThinkingLevel')
        return driver.setThinkingLevel(params.level, control)
      }
      return this.legacy.sessions.setThinkingLevel(params)
    },
    rename: async (params, control) => {
      if (this.owns(params.sessionId)) {
        const owner = this.owned(params.sessionId)!
        const state = await this.driver(params.sessionId).rename(params.name, control)
        if (findPhiSessionById(owner.phiSessionId)) {
          updateSessionManifest(owner.phiSessionId, { title: params.name, titleSource: 'user' })
        }
        return state
      }
      return this.legacy.sessions.rename(params, control)
    },
    contextUsage: async (params) => {
      if (this.owns(params.sessionId)) return this.driver(params.sessionId).contextUsage()
      return this.legacy.sessions.contextUsage(params)
    },
    compact: async (params, control) => {
      if (this.owns(params.sessionId)) {
        const driver = this.driver(params.sessionId)
        if (!driver.compact) throw new RemoteSessionCapabilityError('compact')
        return driver.compact(control)
      }
      return this.legacy.sessions.compact(params)
    },
    setAutoCompactionSettings: async (params, control) => {
      if (this.owns(params.sessionId)) {
        const driver = this.driver(params.sessionId)
        if (!driver.setAutoCompactionSettings)
          throw new RemoteSessionCapabilityError('setAutoCompactionSettings')
        return driver.setAutoCompactionSettings(params.overrides, control)
      }
      return this.legacy.sessions.setAutoCompactionSettings(params)
    },
    enterPlanMode: async (params) => {
      if (this.owns(params.sessionId)) {
        const driver = this.driver(params.sessionId)
        if (!driver.enterPlanMode) throw new RemoteSessionCapabilityError('enterPlanMode')
        return driver.enterPlanMode(params.execute)
      }
      return this.legacy.sessions.enterPlanMode(params)
    },
    cancelPlanMode: async (params) => {
      if (this.owns(params.sessionId)) {
        const driver = this.driver(params.sessionId)
        if (!driver.cancelPlanMode) throw new RemoteSessionCapabilityError('cancelPlanMode')
        return driver.cancelPlanMode(params.replanRequestId)
      }
      return this.legacy.sessions.cancelPlanMode(params)
    }
  }
  readonly history: PhiEngine['history'] = {
    // A remote conversation in this project must not hide the project's other conversations:
    // drop only the local journals a remote locator claims, instead of refusing the whole list.
    list: async (params) => {
      const remote = listPhiSessions().filter(
        (manifest) => manifest.runtimeRef || manifest.runtimeRecoveryError
      )
      const infos = await this.legacy.history.list(params)
      return infos.filter(
        (info) =>
          !remote.some(
            (manifest) =>
              excludesManifestLocalJournalPath(manifest, info.path) ||
              (manifest.runtimeRecoveryError && manifest.runtimeSessionPath === info.path)
          )
      )
    },
    open: async (params) => {
      const routed = await this.factory()?.historyOpen?.(params)
      if (routed) return routed
      this.historyGuard(params.path, params.cwd)
      return this.legacy.history.open(params)
    },
    fork: async (params) => {
      const routed = await this.factory()?.historyFork?.(params)
      if (routed) return routed
      if (phiSessionIdFromPath(params.path)) {
        throw new Error('来源会话尚无可分叉的历史')
      }
      this.historyGuard(params.path, params.cwd)
      return this.legacy.history.fork(params)
    },
    discardFork: async (result) => {
      await this.factory()?.discardHistoryFork?.(result)
    },
    rename: async (params) => {
      const phiId = phiSessionIdFromPath(params.path)
      if (
        phiId &&
        (this.ownsPhi(phiId) ||
          findPhiSessionById(phiId)?.runtimeRef ||
          findPhiSessionById(phiId)?.kernelRuntimeRef ||
          findPhiSessionById(phiId)?.runtimeRecoveryError)
      ) {
        const current = [...this.owners.values()].filter(
          (owner) => owner.phiSessionId === phiId && !owner.retired && owner.driver?.isLive
        )
        if (current.length === 0 && findPhiSessionById(phiId)?.kernelRuntimeRef) {
          return updateSessionManifest(phiId, { title: params.name, titleSource: 'user' })
        }
        if (current.length !== 1)
          throw new RuntimeReferenceError(
            'REMOTE_OPERATION_REQUIRED',
            'Remote title requires an exact live attachment'
          )
        return current[0].driver!.rename(params.name)
      }
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
    onToolApproval: (id, listener) => {
      const entries = this.approvalsById.get(id) ?? new Set()
      this.approvalsById.set(id, entries)
      entries.add(listener)
      const detach = this.legacy.events.onToolApproval(id, (request) => {
        if (!this.owns(id)) listener(request)
      })
      return () => {
        entries.delete(listener)
        if (!entries.size) this.approvalsById.delete(id)
        detach()
      }
    },
    respondToolApproval: async (requestId, result) => {
      const sessionId = this.approvalOwners.get(requestId)
      if (!sessionId) return this.legacy.events.respondToolApproval(requestId, result)
      this.approvalOwners.delete(requestId)
      const driver = this.driver(sessionId)
      if (!driver.respondToolApproval) throw new RemoteSessionCapabilityError('respondToolApproval')
      return driver.respondToolApproval(requestId, result)
    }
  }
  readonly agentRuns: PhiEngine['agentRuns'] = {
    start: (params) => {
      if (this.owns(params.sessionId)) {
        const enabled = this.options.remotePlanExecutionEnabled
        if (
          !(typeof enabled === 'function'
            ? enabled(this.owned(params.sessionId)!.projectId)
            : enabled)
        )
          throw new RemoteSessionCapabilityError('agentRuns.start')
        if (
          typeof params.requestId !== 'string' ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(params.requestId)
        )
          throw new Error('Remote plan child requires a persisted UUID requestId')
        const driver = this.driver(params.sessionId)
        if (!driver.agentRuns?.start) throw new RemoteSessionCapabilityError('agentRuns.start')
        return driver.agentRuns.start({
          ...(params.agent ? { agent: params.agent } : {}),
          task: params.task,
          requestId: params.requestId
        })
      }
      const driver = this.agentRunDriver(params.sessionId)
      if (driver) throw new RemoteSessionCapabilityError('agentRuns.start')
      return this.legacy.agentRuns.start(params)
    },
    list: async (params) => {
      const local = await this.legacy.agentRuns.list(params)
      const remote = (
        await Promise.all(
          [...this.owners.entries()].map(async ([sessionId, owner]) =>
            owner.retired
              ? []
              : ((await owner.driver?.agentRuns?.list())?.map((run) => ({
                  ...run,
                  agentSessionId: sessionId
                })) ?? [])
          )
        )
      ).flat()
      return [...(Array.isArray(local) ? local : []), ...remote]
    },
    resourceOwner: (sessionId, runId) => {
      const driver = this.agentRunDriver(sessionId)
      if (!driver?.agentRuns) throw new RemoteSessionCapabilityError('child resource ownership')
      return driver.agentRuns.resourceOwner(runId)
    },
    wait: (params, signal) => {
      const driver = this.agentRunDriver(params.sessionId)
      if (!driver?.agentRuns) throw new RemoteSessionCapabilityError('child wait')
      return driver.agentRuns.wait({ ...params, signal })
    },
    steer: async (params) => {
      const driver = this.agentRunDriver(params.sessionId)
      if (driver) {
        if (!driver.agentRuns) throw new RemoteSessionCapabilityError('agentRuns.steer')
        await driver.agentRuns.steer(params.runId, params.message ?? '')
        return { ok: true }
      }
      return this.legacy.agentRuns.steer(params)
    },
    stop: (params) => {
      const driver = this.agentRunDriver(params.sessionId)
      if (driver) {
        if (!driver.agentRuns) throw new RemoteSessionCapabilityError('agentRuns.stop')
        return driver.agentRuns.stop(params.runId).then(() => ({ ok: true }))
      }
      return this.legacy.agentRuns.stop(params)
    }
  }
  private agentRunDriver(sessionId: string): RoutedSessionDriver | undefined {
    if (this.owns(sessionId)) return this.driver(sessionId)
    const entries = [...this.owners.entries()].filter(
      ([, owner]) => owner.phiSessionId === sessionId
    )
    if (!entries.length) {
      const manifest = findPhiSessionById(sessionId)
      if (manifest?.runtimeRef || manifest?.runtimeRecoveryError)
        throw new RuntimeReferenceError(
          'REMOTE_OPERATION_REQUIRED',
          '旧远程子任务仅供查看，需要新的实时执行归属才能控制'
        )
      return undefined
    }
    const current = entries.filter(([, owner]) => !owner.retired && owner.driver)
    if (current.length !== 1)
      throw new RuntimeReferenceError('STALE_GENERATION', '子任务代次已改变')
    return this.driver(current[0][0])
  }
  planRunsForPhiSession(phiSessionId: string): RoutedPlanRunOperations | undefined {
    const current = [...this.owners.entries()].filter(
      ([, owner]) => owner.phiSessionId === phiSessionId && !owner.retired && owner.driver
    )
    if (current.length === 0) return undefined
    if (current.length !== 1)
      throw new RuntimeReferenceError('STALE_GENERATION', '计划运行会话代次已改变')
    const planRuns = this.driver(current[0][0]).planRuns
    if (!planRuns) throw new RemoteSessionCapabilityError('planRuns')
    return planRuns
  }
  readonly shellJobs: PhiEngine['shellJobs'] = {
    list: async (params) => {
      const local = await this.legacy.shellJobs.list(params)
      const routed = (
        await Promise.all(
          [...this.owners.values()].map((owner) =>
            owner.retired
              ? Promise.resolve([])
              : Promise.resolve(owner.driver?.shellJobs?.list() ?? [])
          )
        )
      ).flat()
      return [...(Array.isArray(local) ? local : []), ...routed]
    },
    cancel: async (params) => {
      if (this.owns(params.sessionId)) {
        const jobs = this.driver(params.sessionId).shellJobs
        if (!jobs) throw new RemoteSessionCapabilityError('shellJobs.cancel')
        return jobs.cancel(params.jobId)
      }
      return this.legacy.shellJobs.cancel(params)
    }
  }
  async stop(): Promise<void> {
    const factory = this.factory()
    // Close routed sessions before their kernel hosts, or the close requests race a closed client.
    const disposed = await Promise.allSettled(
      [...this.owners.keys()].map((sessionId) => this.sessions.dispose({ sessionId }))
    )
    const stopped = await Promise.allSettled([
      this.legacy.stop(),
      factory?.stop?.() ?? Promise.resolve()
    ])
    const failed = [...disposed, ...stopped].find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}

export function hasRoutedPhiOwner(engine: PhiEngine, phiSessionId: string): boolean {
  return engine instanceof SessionRoutingEngine && engine.ownsPhi(phiSessionId)
}

export function routedPlanRunsForPhiSession(
  engine: PhiEngine,
  phiSessionId: string
): RoutedPlanRunOperations | undefined {
  return engine instanceof SessionRoutingEngine
    ? engine.planRunsForPhiSession(phiSessionId)
    : undefined
}

/** Plan-run IPC options: desktop runs from `planRuns`, kernel-owned sessions' runs from the kernel. */
export function kernelPlanRunRouting<PlanRuns>(
  planRuns: PlanRuns,
  engine: () => PhiEngine
): {
  planRuns: PlanRuns
  findSessionById: typeof findPhiSessionById
  kernelPlanRuns(phiSessionId: string): RoutedPlanRunOperations | undefined
} {
  return {
    planRuns,
    findSessionById: findPhiSessionById,
    kernelPlanRuns: (phiSessionId) => routedPlanRunsForPhiSession(engine(), phiSessionId)
  }
}
