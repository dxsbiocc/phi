import {
  isKernelHostCapabilityName,
  type JsonValue,
  type KernelEventFrame
} from '../../../shared/kernel-protocol'
import type {
  PhiHostRequestHandler,
  PhiSessionCreateParams,
  RuntimeSelectionControl
} from './types'
import type {
  RoutedSessionDriver,
  RoutedSessionFactory,
  RoutedSessionSink
} from './session-routing-engine'
import { readAndPlanKernelHistory } from './kernel-history'
import {
  findPhiSessionById,
  getSessionDir,
  recordKernelRuntimeReference
} from '../session/session-store'
import type { PhiSessionManifest } from '../session/session-store'
import type { KernelRuntimeRef } from '../session/runtime-reference'
import { KernelRoutedSessionDriver } from './kernel-routed-session-driver'
import { KernelExecutionHost } from './kernel-execution-host'
import { projectKernelEvent } from './kernel-event-projection'
import {
  KernelEngineError,
  engineError,
  kernelEngineHandles,
  kernelSessionIdFromJournalPath,
  record,
  sessionCreateParams,
  sessionResources,
  stateFromKernel,
  stringValue,
  type KernelSessionClient,
  type KernelSessionConnection,
  type KernelSessionFactoryOptions,
  type SessionBinding
} from './kernel-session-support'

export {
  KernelEngineError,
  PHI_KERNEL_ENGINE_MODE,
  jsonSafeResourceSnapshot,
  kernelEngineHandles,
  parseKernelEngineSwitch
} from './kernel-session-support'
export type {
  KernelEngineMode,
  KernelSessionClient,
  KernelSessionConnection,
  KernelSessionFactoryOptions,
  KernelSessionLaunchContext,
  KernelSessionLauncher
} from './kernel-session-support'

export class KernelSessionFactory implements RoutedSessionFactory {
  private readonly hosts = new Map<string, KernelExecutionHost>()
  private readonly bindingsByLogical = new Map<string, SessionBinding>()
  private readonly bindingsByKernel = new Map<string, SessionBinding>()
  private readonly hostHandlers = new Map<string, PhiHostRequestHandler>()
  private readonly pendingByHost = new Map<
    string,
    {
      readonly logicalSessionId: string
      readonly params: PhiSessionCreateParams
      kernelSessionId?: string
    }
  >()
  private readonly creationTails = new Map<string, Promise<void>>()
  private readonly earlyEvents = new Map<
    string,
    Array<{
      host: KernelExecutionHost
      event: KernelEventFrame
      payload?: Record<string, JsonValue>
    }>
  >()

  constructor(private readonly options: KernelSessionFactoryOptions) {}

  handles(params: PhiSessionCreateParams): boolean {
    return kernelEngineHandles(this.options.mode, Boolean(params.remoteProject))
  }

  async historyOpen(params: {
    agentDir: string
    path: string
    cwd?: string
  }): Promise<{ cwd?: string; sessionFile?: string } | undefined> {
    const prefix = 'phi-session:'
    if (!params.path.startsWith(prefix)) return undefined
    const phiSessionId = params.path.slice(prefix.length)
    const manifest = findPhiSessionById(phiSessionId)
    if (!manifest) return undefined
    const remote = manifest.projectLocation?.kind === 'ssh'
    if (!kernelEngineHandles(this.options.mode, remote)) return undefined
    if (remote && !manifest.kernelRuntimeRef && !manifest.runtimeRef) {
      throw new KernelEngineError(
        'CAPABILITY_UNAVAILABLE',
        'Legacy SSH sessions remain read-only.',
        {
          reason: 'legacy_ssh_read_only',
          action: 'reopen'
        }
      )
    }
    return { cwd: manifest.cwd, sessionFile: params.path }
  }

  registerHostHandler(method: string, handler: PhiHostRequestHandler): () => void {
    if (!isKernelHostCapabilityName(method)) return () => undefined
    this.hostHandlers.set(method, handler)
    for (const host of this.hosts.values()) host.rebindHostHandler(method, handler)
    return () => {
      if (this.hostHandlers.get(method) !== handler) return
      this.hostHandlers.delete(method)
      for (const host of this.hosts.values()) host.rebindHostHandler(method, undefined)
    }
  }

  hostCapabilityNames(): string[] {
    return [...new Set([...this.hostHandlers.keys(), ...(this.options.hostCapabilities ?? [])])]
      .filter(isKernelHostCapabilityName)
      .sort()
  }

  configureClient(client: KernelSessionClient, hostKey?: string): () => void {
    const cleanup = [...this.hostHandlers.entries()].map(([method, handler]) =>
      this.bindHostHandler(client, method, handler, hostKey)
    )
    const configured = hostKey
      ? this.options.configureClient?.(client, {
          hostKey,
          resolveSession: (kernelSessionId) => this.resolveDesktopSession(hostKey, kernelSessionId),
          snapshotSession: (kernelSessionId) => {
            const binding = this.bindingsByKernel.get(kernelSessionId)
            return binding ? structuredClone(binding.state) : undefined
          }
        })
      : undefined
    if (configured) cleanup.push(configured)
    return () => {
      for (const remove of cleanup.reverse()) remove()
    }
  }

  private resolveDesktopSession(
    hostKey: string,
    kernelSessionId: string
  ):
    | {
        readonly logicalSessionId: string
        readonly kernelSessionId: string
        readonly params: PhiSessionCreateParams
      }
    | undefined {
    const binding = this.bindingsByKernel.get(kernelSessionId)
    if (binding?.hostKey === hostKey) {
      return {
        logicalSessionId: binding.logicalSessionId,
        kernelSessionId,
        params: binding.params
      }
    }
    const pending = this.pendingByHost.get(hostKey)
    if (!pending) return undefined
    if (pending.kernelSessionId && pending.kernelSessionId !== kernelSessionId) return undefined
    pending.kernelSessionId = kernelSessionId
    return { ...pending, kernelSessionId }
  }

  bindHostHandler(
    client: KernelSessionClient,
    method: string,
    handler: PhiHostRequestHandler,
    hostKey?: string
  ): () => void {
    return client.registerHostHandler(method, (params, context) => {
      const binding = context.sessionId
        ? hostKey
          ? this.resolveDesktopSession(hostKey, context.sessionId)
          : this.bindingsByKernel.get(context.sessionId)
        : undefined
      const trustedParams = binding ? this.legacyHostParams(params, binding) : params
      return handler(trustedParams, {
        signal: context.signal,
        ...(binding
          ? { originSessionId: binding.logicalSessionId }
          : context.sessionId
            ? { originSessionId: context.sessionId }
            : {}),
        ...(context.agentRunId ? { agentRunId: context.agentRunId } : {})
      })
    })
  }

  private legacyHostParams(
    params: JsonValue,
    binding: Pick<SessionBinding, 'kernelSessionId' | 'logicalSessionId' | 'params'>
  ): JsonValue {
    const source = record(params)
    if (!source) return params
    const next: Record<string, JsonValue> = structuredClone(source)
    for (const key of ['runtimeSessionId', 'originSessionId']) {
      if (next[key] === binding.kernelSessionId) next[key] = binding.logicalSessionId
    }
    if (binding.params.remoteProject) {
      next.remoteSessionId ??= binding.params.remoteProject.phiSessionId
      next.projectId ??= binding.params.remoteProject.projectId
    }
    const nested = record(next.source)
    if (nested?.sessionId === binding.kernelSessionId) {
      next.source = { ...nested, sessionId: binding.logicalSessionId }
    }
    return next
  }

  async create(
    params: PhiSessionCreateParams,
    signal: AbortSignal,
    sink: RoutedSessionSink,
    control?: RuntimeSelectionControl
  ): Promise<RoutedSessionDriver> {
    control?.assertCurrent()
    signal.throwIfAborted()
    if (!this.handles(params)) throw new Error('Kernel factory does not own this execution host.')
    if (!params.model) throw new KernelEngineError('MODEL_UNAVAILABLE', 'Select a model first.')
    const host = this.hostFor(params)
    const client = await host.client(params, signal)
    control?.assertCurrent()
    signal.throwIfAborted()
    const resources = sessionResources(params)
    const provisional = await this.withHostCreation(host.key, async () => {
      this.pendingByHost.set(host.key, {
        logicalSessionId: params.sessionId,
        params: structuredClone(params)
      })
      try {
        const resolved = await this.resolveKernelSession(params, host, client, resources)
        const kernelSessionId = resolved.sessionId
        const binding: SessionBinding = {
          logicalSessionId: params.sessionId,
          kernelSessionId,
          hostKey: host.key,
          params: structuredClone(params),
          resources,
          ...(resolved.sessionFile ? { sessionFile: resolved.sessionFile } : {}),
          sink,
          ...(params.sessionManager.kind === 'open'
            ? {}
            : { model: structuredClone(params.model) }),
          state: {},
          disposed: false,
          activeAgentRuns: 0
        }
        this.bindingsByLogical.set(params.sessionId, binding)
        this.bindingsByKernel.set(kernelSessionId, binding)
        const early = this.earlyEvents.get(kernelSessionId) ?? []
        this.earlyEvents.delete(kernelSessionId)
        for (const item of early) this.projectEvent(item.host, item.event, item.payload)
        return binding
      } finally {
        this.pendingByHost.delete(host.key)
      }
    })
    const kernelSessionId = provisional.kernelSessionId
    try {
      provisional.state = stateFromKernel(
        await client.request('session.snapshot', {}, { sessionId: kernelSessionId }),
        provisional
      )
      this.recordRuntimeReference(params, host, kernelSessionId)
      return new KernelRoutedSessionDriver(this, host, provisional)
    } catch (error) {
      this.removeBinding(provisional)
      await client
        .request('session.close', {}, { sessionId: kernelSessionId })
        .catch(() => undefined)
      throw engineError(error)
    }
  }

  private async withHostCreation<T>(hostKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.creationTails.get(hostKey) ?? Promise.resolve()
    const gate = Promise.withResolvers<void>()
    const tail = previous.then(() => gate.promise)
    this.creationTails.set(hostKey, tail)
    await previous
    try {
      return await operation()
    } finally {
      gate.resolve()
      if (this.creationTails.get(hostKey) === tail) this.creationTails.delete(hostKey)
    }
  }

  private async resolveKernelSession(
    params: PhiSessionCreateParams,
    host: KernelExecutionHost,
    client: KernelSessionClient,
    resources: JsonValue
  ): Promise<{ sessionId: string; sessionFile?: string }> {
    const manifest = params.phiSessionId ? findPhiSessionById(params.phiSessionId) : null
    const existing = manifest?.kernelRuntimeRef
    if (existing && this.runtimeReferenceMatches(params, host, existing)) {
      await this.openKernelSession(client, existing.kernelSessionId, resources)
      return { sessionId: existing.kernelSessionId }
    }

    const direct = this.directKernelSession(params, host)
    if (direct) {
      await this.openKernelSession(client, direct.sessionId, resources)
      return direct
    }

    if (params.sessionManager.kind === 'open' && manifest && params.phiSessionId) {
      return {
        sessionId: await this.adoptHistory(
          params as PhiSessionCreateParams & { phiSessionId: string },
          host,
          client,
          resources,
          manifest
        )
      }
    }

    const created = record(
      await client.request('session.create', sessionCreateParams(params, resources))
    )
    const createdId = stringValue(created?.sessionId)
    if (!createdId) throw new TypeError('Kernel create result omitted sessionId.')
    const sessionFile = stringValue(created?.sessionFile)
    if (params.sessionManager.kind !== 'memory' && !sessionFile) {
      throw new TypeError('Persistent kernel create result omitted sessionFile.')
    }
    return { sessionId: createdId, ...(sessionFile ? { sessionFile } : {}) }
  }

  private directKernelSession(
    params: PhiSessionCreateParams,
    host: KernelExecutionHost
  ): { sessionId: string; sessionFile: string } | undefined {
    const sessionFile = params.sessionManager.path
    if (params.sessionManager.kind !== 'open' || !sessionFile) return undefined
    const runtimeAgentDir = params.remoteProject
      ? host.currentConnection()?.greeting.runtime.agentDir
      : params.agentDir
    const sessionId = runtimeAgentDir
      ? kernelSessionIdFromJournalPath(sessionFile, runtimeAgentDir)
      : undefined
    return sessionId ? { sessionId, sessionFile } : undefined
  }

  private async openKernelSession(
    client: KernelSessionClient,
    sessionId: string,
    resources: JsonValue
  ): Promise<void> {
    const opened = record(await client.request('session.open', { sessionId, resources }))
    if (stringValue(opened?.sessionId) !== sessionId) {
      throw new TypeError('Kernel opened a different persistent session.')
    }
  }

  private async adoptHistory(
    params: PhiSessionCreateParams & { phiSessionId: string },
    host: KernelExecutionHost,
    client: KernelSessionClient,
    resources: JsonValue,
    manifest: PhiSessionManifest
  ): Promise<string> {
    const plan = params.remoteProject
      ? await host.currentConnection()?.planHistory?.(params)
      : await readAndPlanKernelHistory({
          phiSessionDirectory: getSessionDir(params.phiSessionId, params.agentDir),
          phiSessionId: params.phiSessionId
        })
    if (!plan) {
      throw new KernelEngineError(
        'CAPABILITY_UNAVAILABLE',
        'Remote RPC-era history needs ownership verification before kernel adoption.',
        { reason: 'remote_history_probe_required', action: 'reopen' }
      )
    }
    if (plan.action === 'read-only') {
      throw new KernelEngineError('CAPABILITY_UNAVAILABLE', plan.reason, {
        reason: 'history_read_only',
        action: 'reopen'
      })
    }
    const adopted = record(
      await client.request('session.adopt', {
        source: plan.source,
        ...(manifest.title ? { title: manifest.title } : {}),
        ...(manifest.model
          ? { model: { provider: manifest.model.providerId, id: manifest.model.modelId } }
          : {}),
        ...(manifest.thinkingLevel ? { thinkingLevel: manifest.thinkingLevel } : {})
      })
    )
    const adoptedId = stringValue(adopted?.sessionId)
    if (!adoptedId) throw new TypeError('Kernel adoption omitted sessionId.')
    await this.openKernelSession(client, adoptedId, resources)
    return adoptedId
  }

  private runtimeReferenceMatches(
    params: PhiSessionCreateParams,
    host: KernelExecutionHost,
    reference: KernelRuntimeRef
  ): boolean {
    const connection = host.currentConnection()
    if (!params.remoteProject) {
      return reference.host.kind === 'local' && reference.host.agentDir === params.agentDir
    }
    return Boolean(
      connection?.runtimeRoot &&
      reference.host.kind === 'ssh' &&
      reference.host.hostProfileId === params.remoteProject.location.hostProfileId &&
      reference.host.projectId === params.remoteProject.projectId &&
      reference.host.projectRoot === params.remoteProject.location.canonicalRoot &&
      reference.host.runtimeRoot === connection.runtimeRoot &&
      reference.host.home === connection.greeting.runtime.home &&
      reference.host.agentDir === connection.greeting.runtime.agentDir
    )
  }

  private recordRuntimeReference(
    params: PhiSessionCreateParams,
    host: KernelExecutionHost,
    kernelSessionId: string
  ): void {
    if (!params.phiSessionId) return
    const connection = host.currentConnection()
    if (!connection) throw new Error('Kernel connection disappeared before identity publication.')
    const runtimeRoot = connection.runtimeRoot
    if (params.remoteProject && !runtimeRoot) {
      throw new Error('Remote kernel runtime root disappeared before identity publication.')
    }
    const value: KernelRuntimeRef = params.remoteProject
      ? {
          kind: 'phi-kernel',
          version: 1,
          kernelSessionId,
          host: {
            kind: 'ssh',
            hostProfileId: params.remoteProject.location.hostProfileId,
            projectId: params.remoteProject.projectId,
            projectRoot: params.remoteProject.location.canonicalRoot,
            runtimeRoot: runtimeRoot!,
            home: connection.greeting.runtime.home,
            agentDir: connection.greeting.runtime.agentDir
          }
        }
      : {
          kind: 'phi-kernel',
          version: 1,
          kernelSessionId,
          host: { kind: 'local', agentDir: params.agentDir }
        }
    recordKernelRuntimeReference(params.phiSessionId, value)
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.hosts.values()].map((host) => host.close()))
    this.hosts.clear()
  }

  removeBinding(binding: SessionBinding): void {
    if (this.bindingsByLogical.get(binding.logicalSessionId) === binding) {
      this.bindingsByLogical.delete(binding.logicalSessionId)
    }
    if (this.bindingsByKernel.get(binding.kernelSessionId) === binding) {
      this.bindingsByKernel.delete(binding.kernelSessionId)
    }
  }

  hasLiveSessions(hostKey: string): boolean {
    return [...this.bindingsByLogical.values()].some(
      (binding) => binding.hostKey === hostKey && !binding.disposed
    )
  }

  interruptHost(hostKey: string, error: Error): void {
    for (const binding of this.bindingsByLogical.values()) {
      if (binding.hostKey !== hostKey || binding.disposed) continue
      binding.sink.event({
        type: 'notice',
        level: 'error',
        message: error.message,
        source: 'kernel'
      })
    }
    this.options.onDiagnostic?.(error)
  }

  async reopenHostSessions(host: KernelExecutionHost, client: KernelSessionClient): Promise<void> {
    const bindings = [...this.bindingsByLogical.values()].filter(
      (binding) => binding.hostKey === host.key && !binding.disposed
    )
    for (const binding of bindings) {
      const result = record(
        await client.request('session.open', {
          sessionId: binding.kernelSessionId,
          resources: binding.resources
        })
      )
      if (stringValue(result?.sessionId) !== binding.kernelSessionId) {
        throw new TypeError('Kernel reopened a different session.')
      }
      const snapshot = await client.request(
        'session.snapshot',
        {},
        { sessionId: binding.kernelSessionId }
      )
      host.settleRunFromSnapshot(snapshot)
      binding.state = stateFromKernel(snapshot, binding)
      binding.sink.state(structuredClone(binding.state))
    }
  }

  assertConnectionIdentity(
    params: PhiSessionCreateParams,
    connection: KernelSessionConnection
  ): void {
    const runtime = connection.greeting.runtime
    if (!runtime) return
    if (!params.remoteProject && runtime.agentDir !== params.agentDir) {
      throw new KernelEngineError('STALE_GENERATION', 'Local kernel agent directory changed.')
    }
    if (params.remoteProject && (!runtime.home || !runtime.agentDir)) {
      throw new KernelEngineError('STALE_GENERATION', 'Remote kernel identity is incomplete.')
    }
    if (params.remoteProject && !connection.runtimeRoot) {
      throw new KernelEngineError('STALE_GENERATION', 'Remote kernel runtime root is missing.')
    }
  }

  projectEvent(
    host: KernelExecutionHost,
    event: KernelEventFrame,
    payload: Record<string, JsonValue> | undefined
  ): void {
    if (!event.sessionId) return
    const binding = this.bindingsByKernel.get(event.sessionId)
    if (!binding) {
      const pending = this.earlyEvents.get(event.sessionId) ?? []
      if (pending.length < 128) pending.push({ host, event, ...(payload ? { payload } : {}) })
      this.earlyEvents.set(event.sessionId, pending)
      return
    }
    if (binding.hostKey !== host.key || binding.disposed) return
    projectKernelEvent(binding, event, payload)
  }

  private hostFor(params: PhiSessionCreateParams): KernelExecutionHost {
    const remote = params.remoteProject
    const key = remote ? `ssh:${remote.location.hostProfileId}` : `local:${params.agentDir}`
    const existing = this.hosts.get(key)
    if (existing) return existing
    const launcher = remote ? this.options.launchRemote : this.options.launchLocal
    if (!launcher)
      throw new Error(`Kernel launcher is unavailable for ${remote ? 'remote' : 'local'}.`)
    const host = new KernelExecutionHost(key, this, launcher)
    this.hosts.set(key, host)
    return host
  }
}
