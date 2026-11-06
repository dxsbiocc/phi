import { randomUUID } from 'node:crypto'

import type { KernelHostCapabilityParams } from '../../shared/kernel-protocol'
import { getPhiEngine, type PhiEngineBridge } from './engine/in-process-engine'
import type {
  KernelSessionClient,
  KernelSessionFactoryOptions
} from './engine/kernel-session-factory'
import type { KernelProtocolClient } from './engine/kernel-client'
import {
  DESKTOP_SERVICE_HOST_CAPABILITIES,
  registerKernelDesktopServicesBroker,
  type KernelDesktopMemoryService,
  type KernelDesktopServiceBinding
} from './engine/kernel-host/desktop-services-broker'
import {
  closeDesktopMcpHostBrokerState,
  createDesktopMcpHostBrokerState,
  DESKTOP_MCP_HOST_CAPABILITIES,
  NO_DESKTOP_MCP_SERVERS,
  registerDesktopMcpHostBroker
} from './engine/kernel-host/desktop-mcp-broker'
import type { DesktopMcpAdapter, DesktopMcpOptions } from './engine/rpc/desktop-mcp-types'
import { findPhiSessionById } from './session/session-store'
import { buildProjectMemoryPromptBlock } from './memory/project-memory-files'
import type {
  AppRemoteDesktopResources,
  AppRemoteSessionRoutingOptions
} from './remote-session-routing'

type ConfigureContext = Parameters<NonNullable<KernelSessionFactoryOptions['configureClient']>>[1]
type ResolvedSession = NonNullable<ReturnType<ConfigureContext['resolveSession']>>

class DesktopSessionResolver {
  private readonly resolved = new Map<string, ResolvedSession>()

  constructor(private readonly context: ConfigureContext) {}

  session(kernelSessionId: string): ResolvedSession | undefined {
    const value = this.context.resolveSession(kernelSessionId)
    if (value) this.resolved.set(kernelSessionId, value)
    return value
  }

  known(kernelSessionId: string): ResolvedSession {
    const value = this.resolved.get(kernelSessionId) ?? this.session(kernelSessionId)
    if (!value) throw new Error('Desktop kernel session is unavailable.')
    return value
  }

  binding(kernelSessionId: string): KernelDesktopServiceBinding | undefined {
    const value = this.session(kernelSessionId)
    if (!value) return undefined
    return {
      kernelSessionId,
      runtimeSessionId: value.logicalSessionId,
      cwd: value.params.remoteProject?.location.canonicalRoot ?? value.params.cwd,
      executionHost: value.params.remoteProject ? 'ssh' : 'local',
      ...(value.params.remoteProject
        ? {
            remoteProject: {
              sessionId: value.params.remoteProject.phiSessionId,
              projectId: value.params.remoteProject.projectId
            }
          }
        : {})
    }
  }

  snapshot(kernelSessionId: string): ReturnType<ConfigureContext['snapshotSession']> {
    return this.context.snapshotSession(kernelSessionId)
  }
}

class KernelMemoryScopes {
  private readonly scopes = new Map<string, { scopeId: string; memoryBlock?: string }>()

  constructor(private readonly bridge: PhiEngineBridge) {}

  async ensure(
    resolver: DesktopSessionResolver,
    kernelSessionId: string
  ): Promise<{ scopeId: string; memoryBlock?: string }> {
    const existing = this.scopes.get(kernelSessionId)
    if (existing) return existing
    const value = resolver.known(kernelSessionId)
    const phiSessionId = value.params.phiSessionId ?? value.params.remoteProject?.phiSessionId
    const manifest = phiSessionId ? findPhiSessionById(phiSessionId) : null
    if (!manifest?.projectId) throw new Error('Project memory session is unavailable.')
    const scopeId = randomUUID()
    const created = (await this.bridge.request('memory.desktopCreate', {
      scopeId,
      identity: {
        runtimeSessionId: value.logicalSessionId,
        sessionId: manifest.sessionId,
        projectId: manifest.projectId,
        cwd: value.params.remoteProject?.location.canonicalRoot ?? value.params.cwd
      },
      agentDir: value.params.agentDir,
      cwd: value.params.cwd,
      policy: value.params.memory ?? { enabled: false, learn: false }
    })) as { memoryBlock?: string }
    const scope = { scopeId, ...(created.memoryBlock ? { memoryBlock: created.memoryBlock } : {}) }
    this.scopes.set(kernelSessionId, scope)
    return scope
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.scopes.values()].map((scope) =>
        this.bridge.request('memory.desktopClose', { scopeId: scope.scopeId })
      )
    )
    this.scopes.clear()
  }
}

class ConnectionMemoryService implements KernelDesktopMemoryService {
  constructor(
    private readonly bridge: PhiEngineBridge,
    private readonly resolver: DesktopSessionResolver,
    private readonly scopes: KernelMemoryScopes
  ) {}

  async read(
    binding: KernelDesktopServiceBinding,
    signal: AbortSignal
  ): Promise<{
    memoryBlock?: string
    snapshot: {
      summary: string
      summaryUpdatedAt: string | null
      lessons: Array<{ index: number; text: string }>
    }
  }> {
    signal.throwIfAborted()
    const value = this.resolver.known(binding.kernelSessionId)
    const [scope, snapshot] = await Promise.all([
      this.scopes.ensure(this.resolver, binding.kernelSessionId),
      getPhiEngine().memory.read({ agentDir: value.params.agentDir, cwd: value.params.cwd })
    ])
    signal.throwIfAborted()
    const memoryBlock = scope.memoryBlock ?? buildProjectMemoryPromptBlock(snapshot)
    return { ...(memoryBlock ? { memoryBlock } : {}), snapshot }
  }

  async learn(
    binding: KernelDesktopServiceBinding,
    input: KernelHostCapabilityParams<'memory.learn'>['input'],
    signal: AbortSignal
  ): Promise<{ stored: number }> {
    signal.throwIfAborted()
    const scope = await this.scopes.ensure(this.resolver, binding.kernelSessionId)
    const learned = await this.bridge.request('memory.desktopLearn', {
      scopeId: scope.scopeId,
      requestId: randomUUID(),
      input
    })
    signal.throwIfAborted()
    return learned as { stored: number }
  }

  async ingest(
    binding: KernelDesktopServiceBinding,
    input: Omit<KernelHostCapabilityParams<'memory.ingest'>, 'runtimeSessionId' | 'cwd'>,
    signal: AbortSignal
  ): Promise<{ accepted: boolean; duplicate?: boolean }> {
    signal.throwIfAborted()
    const state = this.resolver.snapshot(binding.kernelSessionId)
    if (!state?.model || !Array.isArray(state.messages)) return { accepted: false }
    const scope = await this.scopes.ensure(this.resolver, binding.kernelSessionId)
    const result = await this.bridge.request('memory.desktopIngest', {
      scopeId: scope.scopeId,
      requestId: randomUUID(),
      source: {
        ompSessionId: binding.kernelSessionId,
        runId: input.runId,
        journalPath:
          input.source.journalPath ?? `${binding.cwd}/.phi-kernel-${binding.kernelSessionId}.jsonl`,
        leafId: null,
        messageCount: state.messages.length,
        messages: state.messages,
        model: { provider: state.model.provider, id: state.model.id }
      }
    })
    signal.throwIfAborted()
    return result as { accepted: boolean; duplicate?: boolean }
  }

  async deleteLesson(
    binding: KernelDesktopServiceBinding,
    input: { index: number; text: string },
    signal: AbortSignal
  ): Promise<{
    snapshot: {
      summary: string
      summaryUpdatedAt: string | null
      lessons: Array<{ index: number; text: string }>
    }
  }> {
    signal.throwIfAborted()
    const value = this.resolver.known(binding.kernelSessionId)
    const snapshot = await getPhiEngine().memory.deleteLesson({
      agentDir: value.params.agentDir,
      cwd: value.params.cwd,
      index: input.index,
      text: input.text
    })
    return {
      snapshot: snapshot as {
        summary: string
        summaryUpdatedAt: string | null
        lessons: Array<{ index: number; text: string }>
      }
    }
  }

  async clear(binding: KernelDesktopServiceBinding, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const value = this.resolver.known(binding.kernelSessionId)
    await getPhiEngine().memory.clear({
      agentDir: value.params.agentDir,
      cwd: value.params.cwd
    })
  }
}

export class AppKernelDesktopServices {
  readonly hostCapabilities = [
    ...DESKTOP_SERVICE_HOST_CAPABILITIES,
    ...DESKTOP_MCP_HOST_CAPABILITIES
  ]
  private readonly scopes: KernelMemoryScopes
  private readonly mcpState = createDesktopMcpHostBrokerState()
  private readonly mcpResources = new Map<string, AppRemoteDesktopResources>()
  private readonly pendingMcpAdapters = new Map<string, DesktopMcpAdapter>()

  constructor(
    private readonly options: AppRemoteSessionRoutingOptions,
    private readonly bridge: PhiEngineBridge
  ) {
    this.scopes = new KernelMemoryScopes(bridge)
  }

  configureClient = (client: KernelSessionClient, context: ConfigureContext): (() => void) => {
    const resolver = new DesktopSessionResolver(context)
    const broker = registerKernelDesktopServicesBroker(client as unknown as KernelProtocolClient, {
      services: this.bridge.hostServices,
      resolveSession: (kernelSessionId) => resolver.binding(kernelSessionId),
      evaluateDecision: (binding, model, request, signal) => {
        const value = resolver.known(binding.kernelSessionId)
        return getPhiEngine().decisions.evaluate(
          { agentDir: value.params.agentDir, sessionId: binding.runtimeSessionId, model, request },
          signal
        )
      },
      executeLibrary: (binding, action, params, signal) =>
        this.bridge.hostServices.invoke(
          'library.execute',
          { runtimeSessionId: binding.runtimeSessionId, action, params },
          { signal, originSessionId: binding.runtimeSessionId }
        ) as Promise<{ summary: string; details: Record<string, unknown> }>,
      memory: new ConnectionMemoryService(this.bridge, resolver, this.scopes)
    })
    const mcp = registerDesktopMcpHostBroker(client as unknown as KernelProtocolClient, {
      state: this.mcpState,
      retainStateOnClose: true,
      resolve: (input) => this.resolveDesktopMcp(resolver, input),
      createAdapter: async (mcpOptions) => {
        const adapter = this.pendingMcpAdapters.get(mcpOptions.identity.runtimeSessionId)
        if (!adapter) throw new Error('Desktop MCP adapter preparation was lost.')
        this.pendingMcpAdapters.delete(mcpOptions.identity.runtimeSessionId)
        return adapter
      }
    })
    return () => {
      void Promise.allSettled([broker.close(), mcp.close()])
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.scopes.close(),
      closeDesktopMcpHostBrokerState(this.mcpState),
      ...[...this.mcpResources.values()].map((resources) => resources.close?.())
    ])
    this.mcpResources.clear()
    this.pendingMcpAdapters.clear()
  }

  private async resolveDesktopMcp(
    resolver: DesktopSessionResolver,
    input: { bindingId: string; kernelSessionId: string; cwd: string; signal: AbortSignal }
  ): Promise<DesktopMcpOptions | typeof NO_DESKTOP_MCP_SERVERS | undefined> {
    const value = resolver.known(input.kernelSessionId)
    const remote = value.params.remoteProject
    if (
      !remote ||
      value.params.desktopMcp?.bindingId !== input.bindingId ||
      !this.options.loadDesktopTools
    ) {
      return undefined
    }
    let resources = this.mcpResources.get(input.kernelSessionId)
    if (!resources) {
      resources = await this.options.loadDesktopTools(
        {
          runtimeSessionId: value.logicalSessionId,
          sessionId: remote.phiSessionId,
          projectId: remote.projectId,
          cwd: remote.location.canonicalRoot,
          resourceCwd: value.params.cwd,
          excludedMcpServerNames: value.params.mcpServers?.map((server) => server.name) ?? []
        },
        input.signal
      )
      this.mcpResources.set(input.kernelSessionId, resources)
    }
    const adapter = resources.tools.desktopMcp
    if (!adapter) return NO_DESKTOP_MCP_SERVERS
    // The adapter keeps the logical Phi owner used by desktop dispatch guards; only the
    // kernel-facing broker binding uses the kernel protocol's session identity.
    this.pendingMcpAdapters.set(input.kernelSessionId, adapter)
    return {
      identity: { ...adapter.identity, runtimeSessionId: input.kernelSessionId },
      agentDir: value.params.agentDir,
      resourceCwd: value.params.cwd,
      serverNames: [],
      approvalFor: (name, toolInput) => adapter.approvalFor(name, toolInput),
      signal: input.signal,
      bridge: this.bridge
    }
  }
}
