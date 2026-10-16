import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { approvalIdentifier } from '../../phi-extension/lib/rpc-approval-protocol'
import {
  rpcChildPromptDigest,
  sameRpcChildRoot,
  sameRpcChildModel,
  sameRpcChildRoute,
  snapshotRpcChildProfile,
  sameRpcChildScope,
  validateRpcChildActual,
  validateRpcChildRoot,
  validateRpcChildScope,
  type RpcChildActualProfile,
  type RpcChildRootScope,
  type RpcChildScope
} from '../../phi-extension/lib/rpc-child-protocol'
import type { RpcFrame } from '../types'
import type { RpcChildTrustedProfile } from '../../phi-extension/lib/rpc-child-protocol'
import type { RpcAgentDefinitionProfile, RpcAgentServerBinding, RpcChildRunSnapshot } from './types'
import { snapshotBinding } from './definition-validation'
import type { SafeModelDescriptor } from '../../model-gateway-types'

/** Reject unsupported compiler resources before constructing the package-local wire profile. */
export function rpcChildProfileFromDefinition(
  definition: RpcAgentDefinitionProfile,
  systemPrompt: readonly string[],
  model: SafeModelDescriptor,
  route: RpcChildTrustedProfile['route'],
  resources: { readonly resourcesDigest?: string; readonly effectivePromptDigest?: string } = {}
): RpcChildTrustedProfile {
  if (
    typeof model.contextWindow !== 'number' ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow < 1 ||
    typeof model.maxTokens !== 'number' ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens < 1 ||
    model.provider !== definition.model.provider ||
    model.id !== definition.model.id ||
    !definition.thinkingLevel ||
    ((definition.environment ||
      definition.skills.length ||
      definition.tools.some((tool) => tool.site !== 'native')) &&
      !resources.resourcesDigest)
  )
    throw new Error('Unverifiable compiler child profile')
  return snapshotRpcChildProfile({
    definition: {
      definitionHash: definition.definitionHash,
      phiName: definition.phiName,
      ...(definition.displayName ? { displayName: definition.displayName } : {}),
      nativeName: definition.nativeName,
      blocking: definition.blocking,
      tools: definition.tools,
      skills: definition.skills,
      model: definition.model,
      thinkingLevel: definition.thinkingLevel,
      ...(definition.environment
        ? {
            environment: {
              ref: definition.environment.ref,
              ...(definition.environment.pluginId
                ? { pluginId: definition.environment.pluginId }
                : {})
            }
          }
        : {}),
      ...(resources.resourcesDigest ? { resourcesDigest: resources.resourcesDigest } : {})
    },
    model: {
      provider: model.provider,
      id: model.id,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens
    },
    route: { api: route.api, baseUrl: route.baseUrl, transport: route.transport },
    systemPrompt,
    ...(resources.effectivePromptDigest
      ? { effectivePromptDigest: resources.effectivePromptDigest }
      : {}),
    expectedAgentSource: 'user'
  })
}
export interface RpcChildStarted {
  readonly id: string
  readonly agent: string
  readonly agentSource: string
  readonly parentToolCallId: string
  readonly sessionFile: string
  readonly detached: boolean
}
export interface RpcChildRun {
  readonly id: string
  readonly parentRunId: string
  readonly parentToolCallId: string
  readonly scope: RpcChildScope
  readonly profile: RpcChildActualProfile
  readonly signal: AbortSignal
  /** Existing model requests drain after SDK cancellation; this grants no new execution. */
  readonly modelSignal: AbortSignal
}
interface Entry {
  readonly id: string
  scope?: RpcChildScope
  started?: RpcChildStarted
  parentRunId?: string
  run?: RpcChildRun
  controller: AbortController
  readonly modelController: AbortController
  failed: boolean
  terminal?: 'completed' | 'failed' | 'aborted'
  startedAt?: number
  completedAt?: number
  lastSnapshot?: string
  terminalWaiters: Set<(status: string | undefined) => void>
  waiters: Set<(run: RpcChildRun | undefined) => void>
}
export interface RpcChildRegistryOptions {
  readonly identity: RpcChildRootScope
  readonly manifestBinding: RpcAgentServerBinding
  readonly profiles: readonly RpcChildTrustedProfile[]
  /** Trusted desktop parent-call ledger. A normally finished turn remains identifiable. */
  readonly captureParent: (started: RpcChildStarted) => { readonly runId: string } | undefined
  readonly signal: AbortSignal
  readonly maxChildren?: number
}

/** One root generation owns child lifetime; main turn settlement never retires a child. */
export class RpcChildRunRegistry {
  readonly identity: RpcChildRootScope
  private readonly profiles = new Map<string, RpcChildActualProfile>()
  private readonly names = new Map<string, string>()
  private readonly blocking = new Map<string, boolean>()
  private readonly toolSites = new Map<string, ReadonlyMap<string, 'native' | 'host'>>()
  private readonly listeners = new Set<(snapshot: Readonly<RpcChildRunSnapshot>) => void>()
  private readonly entries = new Map<string, Entry>()
  private readonly hashes = new Map<string, string>()
  private readonly cancelledParents = new Set<string>()
  private readonly maximum: number
  private disposed = false
  private readonly abort = (): void => this.dispose()
  get isActive(): boolean {
    return !this.disposed && !this.options.signal.aborted
  }

  constructor(private readonly options: RpcChildRegistryOptions) {
    this.options = Object.freeze({ ...options })
    this.identity = validateRpcChildRoot(options.identity)
    const manifestBinding = snapshotBinding(options.manifestBinding)
    if (
      manifestBinding.projectId !== this.identity.projectId ||
      manifestBinding.projectRoot !== this.identity.cwd
    )
      throw new Error('Child manifest project binding mismatch')
    this.maximum = options.maxChildren ?? 256
    if (
      typeof options.captureParent !== 'function' ||
      !Number.isSafeInteger(this.maximum) ||
      this.maximum < 1 ||
      this.maximum > 4096 ||
      !Array.isArray(options.profiles) ||
      options.profiles.length > 128
    )
      throw new Error('Invalid child registry configuration')
    for (const candidate of options.profiles) {
      const profile = snapshotRpcChildProfile(candidate)
      const definition = profile.definition
      if (this.profiles.has(definition.nativeName)) throw new Error('Duplicate child profile')
      this.hashes.set(definition.nativeName, definition.definitionHash)
      this.names.set(definition.nativeName, definition.displayName ?? definition.phiName)
      this.blocking.set(definition.nativeName, definition.blocking)
      this.toolSites.set(
        definition.nativeName,
        new Map(definition.tools.map((tool) => [tool.name, tool.site]))
      )
      this.profiles.set(
        definition.nativeName,
        validateRpcChildActual({
          tools: definition.tools.map((tool) => tool.name),
          model: profile.model,
          route: profile.route,
          systemPromptDigest:
            profile.effectivePromptDigest ?? rpcChildPromptDigest(profile.systemPrompt),
          ...(definition.resourcesDigest ? { resourcesDigest: definition.resourcesDigest } : {}),
          ...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {})
        })
      )
    }
    options.signal.addEventListener('abort', this.abort, { once: true })
    if (options.signal.aborted) this.dispose()
  }
  register(input: RpcChildScope): boolean {
    const scope = validateRpcChildScope(input)
    if (
      !sameRpcChildRoot(scope, this.identity) ||
      this.hashes.get(scope.nativeName) !== scope.definitionHash
    )
      return false
    // Native task journals are siblings of the root journal, in its SDK-owned task directory.
    if (
      !this.identity.rootSessionFile.endsWith('.jsonl') ||
      posix.dirname(scope.childSessionFile) !== this.identity.rootSessionFile.slice(0, -6)
    )
      return false
    const entry = this.entry(scope.nativeAgentId)
    if (!entry || entry.failed || entry.scope) return false
    entry.scope = scope
    this.join(entry)
    return !entry.failed
  }
  observe(frame: RpcFrame): void {
    if (this.disposed || frame.type !== 'subagent_lifecycle') return
    const payload = frame.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    const value = payload as Record<string, unknown>
    if (!approvalIdentifier(value.id)) return
    const entry = this.entry(value.id)
    if (!entry) return
    if (value.status === 'started') {
      if (
        entry.started ||
        !approvalIdentifier(value.agent) ||
        value.agentSource !== 'user' ||
        !approvalIdentifier(value.parentToolCallId) ||
        typeof value.sessionFile !== 'string' ||
        (value.detached !== undefined && typeof value.detached !== 'boolean')
      ) {
        this.retire(entry)
        return
      }
      const started: RpcChildStarted = Object.freeze({
        id: value.id,
        agent: value.agent,
        agentSource: value.agentSource,
        parentToolCallId: value.parentToolCallId,
        sessionFile: value.sessionFile,
        detached: value.detached === true
      })
      if (
        !this.names.has(started.agent) ||
        started.detached !== (this.blocking.get(started.agent) === false)
      ) {
        this.retire(entry)
        return
      }
      let parent: ReturnType<RpcChildRegistryOptions['captureParent']>
      try {
        parent = this.options.captureParent(started)
      } catch {
        this.retire(entry)
        return
      }
      if (!parent || !approvalIdentifier(parent.runId) || this.disposed) {
        this.retire(entry)
        return
      }
      entry.started = started
      entry.startedAt = Date.now()
      entry.parentRunId = parent.runId
      // Permission retirement must not erase a verified native identity needed for cancellation.
      if (this.cancelledParents.has(parent.runId) || entry.failed) {
        this.retire(entry)
        this.notify(entry)
        return
      }
      this.join(entry)
      this.notify(entry)
    } else if (['completed', 'failed', 'aborted'].includes(String(value.status))) {
      if (entry.terminal) return
      if (!entry.started) {
        this.retire(entry)
        return
      }
      if (
        value.agent === entry.started.agent &&
        value.parentToolCallId === entry.started.parentToolCallId &&
        value.sessionFile === entry.started.sessionFile &&
        value.agentSource === 'user'
      ) {
        entry.terminal = value.status as 'completed' | 'failed' | 'aborted'
        entry.completedAt = Date.now()
        for (const resolve of [...entry.terminalWaiters]) resolve(entry.terminal)
        this.retire(entry)
        this.notify(entry)
      }
    }
  }
  async activate(
    scope: RpcChildScope,
    actual: RpcChildActualProfile,
    signal: AbortSignal
  ): Promise<RpcChildRun | undefined> {
    const entry = this.entries.get(scope.nativeAgentId)
    if (!entry?.scope || !sameRpcChildScope(scope, entry.scope) || entry.failed || signal.aborted)
      return undefined
    const expected = this.profiles.get(scope.nativeName)
    const normalized = validateRpcChildActual(actual)
    if (
      !expected ||
      !sameRpcChildModel(normalized.model, expected.model) ||
      !sameRpcChildRoute(normalized.route, expected.route) ||
      normalized.systemPromptDigest !== expected.systemPromptDigest ||
      normalized.resourcesDigest !== expected.resourcesDigest ||
      normalized.thinkingLevel !== expected.thinkingLevel ||
      normalized.tools.join('\0') !== expected.tools.join('\0')
    ) {
      this.retire(entry)
      return undefined
    }
    if (entry.run) return entry.run
    return new Promise((resolve) => {
      const finish = (run: RpcChildRun | undefined): void => {
        entry.waiters.delete(finish)
        signal.removeEventListener('abort', abort)
        resolve(run)
      }
      const abort = (): void => finish(undefined)
      entry.waiters.add(finish)
      signal.addEventListener('abort', abort, { once: true })
      this.join(entry)
      if (entry.failed || this.disposed || signal.aborted) finish(undefined)
    })
  }
  current(scope: RpcChildScope): RpcChildRun | undefined {
    const entry = this.entries.get(scope.nativeAgentId)
    return entry?.run &&
      !entry.failed &&
      !entry.controller.signal.aborted &&
      sameRpcChildScope(scope, entry.run.scope)
      ? entry.run
      : undefined
  }
  toolSite(scope: RpcChildScope, toolName: string): 'native' | 'host' | undefined {
    return this.current(scope) ? this.toolSites.get(scope.nativeName)?.get(toolName) : undefined
  }
  cancelChild(scope: RpcChildScope): void {
    const entry = this.entries.get(scope.nativeAgentId)
    if (entry?.scope && sameRpcChildScope(scope, entry.scope)) this.retire(entry)
  }
  revokeNative(nativeId: string): void {
    const entry = this.entries.get(nativeId)
    if (entry?.started && entry.parentRunId) this.retire(entry, false)
  }
  drainModel(nativeId: string): void {
    this.entries.get(nativeId)?.modelController.abort()
  }
  drainParentModels(parentRunId: string): void {
    for (const entry of this.entries.values())
      if (entry.parentRunId === parentRunId) entry.modelController.abort()
  }
  waitForTerminal(nativeId: string, signal: AbortSignal): Promise<string | undefined> {
    const entry = this.entries.get(nativeId)
    if (!entry || signal.aborted || this.disposed) return Promise.resolve(undefined)
    if (entry.terminal) return Promise.resolve(entry.terminal)
    return new Promise((resolve) => {
      const finish = (status: string | undefined): void => {
        entry.terminalWaiters.delete(finish)
        signal.removeEventListener('abort', abort)
        resolve(status)
      }
      const abort = (): void => finish(undefined)
      entry.terminalWaiters.add(finish)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted || this.disposed) finish(undefined)
    })
  }
  nativeChildren(parentRunId: string): readonly string[] {
    return Object.freeze(
      [...this.entries.values()].flatMap((entry) =>
        !entry.terminal && entry.parentRunId === parentRunId && entry.started
          ? [entry.started.id]
          : []
      )
    )
  }
  cancelParent(runId: string): void {
    if (!approvalIdentifier(runId) || this.cancelledParents.size >= 4096) {
      this.dispose()
      return
    }
    this.cancelledParents.add(runId)
    for (const entry of this.entries.values())
      if (entry.parentRunId === runId) this.retire(entry, false)
  }
  snapshot(): readonly RpcChildRun[] {
    return Object.freeze(
      [...this.entries.values()].flatMap((entry) => (entry.run && !entry.failed ? [entry.run] : []))
    )
  }
  /** Public lifecycle facts survive permission retirement; they grant no execution authority. */
  records(): readonly Readonly<RpcChildRunSnapshot>[] {
    return Object.freeze(
      [...this.entries.values()].flatMap((entry) => {
        const record = this.describe(entry)
        return record ? [record] : []
      })
    )
  }
  getRecord(id: string): Readonly<RpcChildRunSnapshot> | undefined {
    return this.records().find((record) => record.id === id)
  }
  recordForNative(nativeId: string): Readonly<RpcChildRunSnapshot> | undefined {
    const entry = this.entries.get(nativeId)
    return entry && this.describe(entry)
  }
  getRun(id: string): RpcChildRun | undefined {
    for (const entry of this.entries.values()) if (entry.run?.id === id) return entry.run
    return undefined
  }
  onChange(listener: (snapshot: Readonly<RpcChildRunSnapshot>) => void): () => void {
    if (this.disposed) throw new Error('Child registry is unavailable')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.options.signal.removeEventListener('abort', this.abort)
    for (const entry of this.entries.values()) {
      this.retire(entry)
      for (const resolve of [...entry.terminalWaiters]) resolve(undefined)
    }
    this.entries.clear()
    this.listeners.clear()
  }
  private entry(id: string): Entry | undefined {
    if (this.disposed) return undefined
    let entry = this.entries.get(id)
    if (!entry) {
      if (this.entries.size >= this.maximum) return undefined
      entry = {
        id: randomUUID(),
        controller: new AbortController(),
        modelController: new AbortController(),
        failed: false,
        waiters: new Set(),
        terminalWaiters: new Set()
      }
      this.entries.set(id, entry)
    }
    return entry
  }
  private join(entry: Entry): void {
    if (entry.failed || !entry.scope || !entry.started || !entry.parentRunId) return
    if (
      entry.started.id !== entry.scope.nativeAgentId ||
      entry.started.agent !== entry.scope.nativeName ||
      entry.started.sessionFile !== entry.scope.childSessionFile ||
      entry.started.detached !== (this.blocking.get(entry.scope.nativeName) === false)
    ) {
      this.retire(entry)
      return
    }
    if (!entry.run && entry.waiters.size) {
      const profile = this.profiles.get(entry.scope.nativeName)!
      entry.run = Object.freeze({
        id: entry.id,
        parentRunId: entry.parentRunId,
        parentToolCallId: entry.started.parentToolCallId,
        scope: entry.scope,
        profile,
        signal: entry.controller.signal,
        modelSignal: entry.modelController.signal
      })
      this.notify(entry)
    }
    if (entry.run) for (const resolve of [...entry.waiters]) resolve(entry.run)
  }
  private retire(entry: Entry, drainModel = true): void {
    if (drainModel) entry.modelController.abort()
    if (entry.failed) return
    entry.failed = true
    entry.controller.abort()
    for (const resolve of [...entry.waiters]) resolve(undefined)
    this.notify(entry)
  }
  private describe(entry: Entry): Readonly<RpcChildRunSnapshot> | undefined {
    if (!entry.started || !entry.parentRunId || entry.startedAt === undefined) return undefined
    const agent = this.names.get(entry.started.agent)
    if (!agent) return undefined
    return Object.freeze({
      id: entry.id,
      phiSessionId: this.identity.phiSessionId,
      projectId: this.identity.projectId,
      generation: this.identity.generation,
      parentRunId: entry.parentRunId,
      parentToolCallId: entry.started.parentToolCallId,
      nativeId: entry.started.id,
      childSessionFile: entry.started.sessionFile,
      ...(entry.scope ? { childOmpSessionId: entry.scope.childOmpSessionId } : {}),
      agent,
      background: entry.started.detached,
      status:
        entry.terminal === 'completed' && !entry.run
          ? 'failed'
          : (entry.terminal ?? (entry.failed ? 'interrupted' : entry.run ? 'running' : 'queued')),
      verified: !!entry.run,
      startedAt: entry.startedAt,
      ...(entry.completedAt === undefined ? {} : { completedAt: entry.completedAt })
    })
  }
  private notify(entry: Entry): void {
    const snapshot = this.describe(entry)
    if (!snapshot) return
    const encoded = JSON.stringify(snapshot)
    if (entry.lastSnapshot === encoded) return
    entry.lastSnapshot = encoded
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        /* Observers cannot extend child authority. */
      }
    }
  }
}
