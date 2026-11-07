import { rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  isKernelHostCapabilityName,
  SESSION_FORK_CUT_PROTOCOL_MINOR,
  type JsonValue,
  type KernelEventFrame
} from '../../../shared/kernel-protocol'
import type {
  PhiHostRequestHandler,
  PhiHistoryForkParams,
  PhiHistoryForkResult,
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
  kernelHistoryAdoptionRequest,
  publishKernelHistoryAdoption,
  verifiedKernelAdoption
} from './kernel-session-history'
import {
  KernelEngineError,
  engineError,
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
  jsonSafeResourceSnapshot
} from './kernel-session-support'
export type {
  KernelSessionClient,
  KernelSessionConnection,
  KernelSessionFactoryOptions,
  KernelSessionLaunchContext,
  KernelSessionLauncher
} from './kernel-session-support'

type LocalKernelRuntimeRef = Omit<KernelRuntimeRef, 'host'> & {
  host: { kind: 'local'; agentDir: string }
}

function kernelForkSourceParams(
  phiSessionId: string,
  path: string,
  manifest: PhiSessionManifest,
  reference: LocalKernelRuntimeRef
): PhiSessionCreateParams {
  return {
    sessionId: phiSessionId,
    phiSessionId,
    cwd: manifest.cwd,
    agentDir: reference.host.agentDir,
    ...(manifest.model
      ? {
          model: {
            provider: manifest.model.providerId,
            id: manifest.model.modelId,
            name: manifest.model.modelId,
            reasoning: false
          }
        }
      : {}),
    ...(manifest.thinkingLevel ? { thinkingLevel: manifest.thinkingLevel } : {}),
    ...(manifest.autoCompaction ? { autoCompaction: manifest.autoCompaction } : {}),
    sessionManager: { kind: 'open', cwd: manifest.cwd, path },
    enableToolApproval: manifest.permissionMode === 'ask',
    ...(manifest.workMode ? { workMode: manifest.workMode } : {})
  }
}

export class KernelSessionFactory implements RoutedSessionFactory {
  private readonly hosts = new Map<string, KernelExecutionHost>()
  private readonly bindingsByLogical = new Map<string, SessionBinding>()
  private readonly bindingsByKernel = new Map<string, SessionBinding>()
  /** The host of each remote fork, so a fork the desktop fails to adopt can be closed there. */
  private readonly remoteForkHosts = new Map<string, string>()
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

  async historyFork(params: PhiHistoryForkParams): Promise<PhiHistoryForkResult | undefined> {
    const source = this.historyForkSource(params.path)
    if (!source) return undefined
    const { reference } = source
    const sourceParams = this.forkSourceParams(source, params.path)
    const host = this.hostFor(sourceParams)
    const client = await host.client(sourceParams, new AbortController().signal)
    if (
      (host.currentConnection()?.greeting.protocol.minor ?? 0) < SESSION_FORK_CUT_PROTOCOL_MINOR
    ) {
      throw new KernelEngineError(
        'CAPABILITY_UNAVAILABLE',
        '本地内核版本过旧，无法从所选消息分叉；请重新打开会话后重试。',
        { reason: 'kernel_fork_cut_protocol_upgrade_required', action: 'reopen' }
      )
    }
    await this.openKernelSession(client, reference.kernelSessionId, {})
    // The fork's runtime is created before the desktop knows its id. Its host requests (skill
    // tools, environments) must still resolve to the source's project, as a new session's do.
    const result = await this.withHostCreation(host.key, async () => {
      this.pendingByHost.set(host.key, {
        logicalSessionId: sourceParams.sessionId,
        params: structuredClone(sourceParams)
      })
      try {
        return record(
          await client.request(
            'session.fork',
            { cut: { userMessages: params.userMessages, selectedIndex: params.selectedIndex } },
            { sessionId: reference.kernelSessionId }
          )
        )
      } finally {
        this.pendingByHost.delete(host.key)
      }
    })
    const forkedSessionId = stringValue(result?.sessionId)
    const forkedPath = stringValue(result?.sessionFile)
    if (
      !forkedSessionId ||
      !forkedPath ||
      kernelSessionIdFromJournalPath(forkedPath, reference.host.agentDir) !== forkedSessionId
    ) {
      if (forkedSessionId) {
        await client
          .request('session.close', {}, { sessionId: forkedSessionId })
          .catch(() => undefined)
        if (reference.host.kind === 'local')
          this.removeLocalKernelFork(reference.host.agentDir, forkedSessionId)
      }
      throw new TypeError('Kernel fork result omitted a valid persistent session identity.')
    }
    if (reference.host.kind === 'ssh') this.remoteForkHosts.set(forkedSessionId, host.key)
    return {
      path: forkedPath,
      kernelRuntimeRef: { ...reference, kernelSessionId: forkedSessionId }
    }
  }

  private forkSourceParams(
    source: NonNullable<ReturnType<KernelSessionFactory['historyForkSource']>>,
    path: string
  ): PhiSessionCreateParams {
    const { phiSessionId, manifest, reference } = source
    const binding = this.bindingForPhiSession(phiSessionId, reference.kernelSessionId)
    if (binding) return binding.params
    // A remote kernel is reached only through the source session's own launch; the desktop
    // attaches that session before asking for the fork.
    if (reference.host.kind === 'ssh') {
      throw new KernelEngineError(
        'CAPABILITY_UNAVAILABLE',
        '远程会话尚未连接，无法分叉；请稍后重试。',
        {
          reason: 'remote_kernel_fork_source_detached',
          action: 'reopen'
        }
      )
    }
    return kernelForkSourceParams(phiSessionId, path, manifest, reference as LocalKernelRuntimeRef)
  }

  /** Bindings are keyed by runtime session; a fork names the Phi session it came from. */
  private bindingForPhiSession(
    phiSessionId: string,
    kernelSessionId: string
  ): SessionBinding | undefined {
    const direct = this.bindingsByLogical.get(phiSessionId)
    if (direct) return direct
    const byKernel = this.bindingsByKernel.get(kernelSessionId)
    return byKernel &&
      (byKernel.params.phiSessionId ?? byKernel.params.remoteProject?.phiSessionId) === phiSessionId
      ? byKernel
      : undefined
  }

  private historyForkSource(path: string):
    | {
        phiSessionId: string
        manifest: PhiSessionManifest
        reference: KernelRuntimeRef
      }
    | undefined {
    const prefix = 'phi-session:'
    if (!path.startsWith(prefix)) return undefined
    const phiSessionId = path.slice(prefix.length)
    const manifest = findPhiSessionById(phiSessionId)
    const reference = manifest?.kernelRuntimeRef
    if (!manifest || !reference) return undefined
    return { phiSessionId, manifest, reference }
  }

  async discardHistoryFork(result: PhiHistoryForkResult): Promise<boolean> {
    const reference = result.kernelRuntimeRef
    if (reference?.host.kind === 'ssh') {
      const hostKey = this.remoteForkHosts.get(reference.kernelSessionId)
      this.remoteForkHosts.delete(reference.kernelSessionId)
      if (!hostKey) return false
      await this.hosts
        .get(hostKey)
        ?.currentConnection()
        ?.client.request('session.close', {}, { sessionId: reference.kernelSessionId })
        .catch(() => undefined)
      return true
    }
    if (!reference || reference.host.kind !== 'local') return false
    if (
      kernelSessionIdFromJournalPath(result.path, reference.host.agentDir) !==
      reference.kernelSessionId
    ) {
      return false
    }
    const host = this.hosts.get(`local:${reference.host.agentDir}`)
    await host
      ?.currentConnection()
      ?.client.request('session.close', {}, { sessionId: reference.kernelSessionId })
      .catch(() => undefined)
    return true
  }

  private removeLocalKernelFork(agentDir: string, sessionId: string): void {
    if (!sessionId || sessionId === '.' || sessionId === '..' || /[/\\]/.test(sessionId)) return
    rmSync(join(agentDir, 'phi-kernel', 'sessions', sessionId), {
      recursive: true,
      force: true
    })
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
          ? { originSessionId: binding.logicalSessionId, kernelOrigin: true as const }
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
          phiSessionDirectory: getSessionDir(params.phiSessionId),
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
    const { adoptedId, sourceSha256 } = verifiedKernelAdoption(
      await client.request('session.adopt', kernelHistoryAdoptionRequest(params, manifest, plan))
    )
    await this.openKernelSession(client, adoptedId, resources)
    const connection = host.currentConnection()
    const runtimeAgentDir = connection?.greeting.runtime.agentDir
    if (!runtimeAgentDir) throw new Error('Kernel adoption runtime identity is incomplete.')
    await publishKernelHistoryAdoption({
      params,
      plan,
      adoptedId,
      runtimeAgentDir,
      sourceSha256
    })
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
