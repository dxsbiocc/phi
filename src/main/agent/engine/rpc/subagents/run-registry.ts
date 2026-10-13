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
import type { RpcAgentDefinitionProfile, RpcAgentServerBinding } from './types'
import { snapshotBinding } from './definition-validation'
import type { SafeModelDescriptor } from '../../model-gateway-types'

/** Reject unsupported compiler resources before constructing the package-local wire profile. */
export function rpcChildProfileFromDefinition(
  definition: RpcAgentDefinitionProfile,
  systemPrompt: readonly string[],
  model: SafeModelDescriptor,
  route: RpcChildTrustedProfile['route']
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
    definition.environment ||
    definition.skills.length ||
    !definition.blocking ||
    !definition.thinkingLevel ||
    definition.tools.some((tool) => tool.site !== 'native')
  )
    throw new Error('Unverifiable compiler child profile')
  return snapshotRpcChildProfile({
    definition: {
      definitionHash: definition.definitionHash,
      phiName: definition.phiName,
      nativeName: definition.nativeName,
      blocking: definition.blocking,
      tools: definition.tools,
      skills: definition.skills,
      model: definition.model,
      thinkingLevel: definition.thinkingLevel
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
}
interface Entry {
  scope?: RpcChildScope
  started?: RpcChildStarted
  parentRunId?: string
  run?: RpcChildRun
  controller: AbortController
  failed: boolean
  terminal?: 'completed' | 'failed' | 'aborted'
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
  private readonly entries = new Map<string, Entry>()
  private readonly hashes = new Map<string, string>()
  private readonly cancelledParents = new Set<string>()
  private readonly maximum: number
  private disposed = false
  private readonly abort = (): void => this.dispose()

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
      this.profiles.set(
        definition.nativeName,
        validateRpcChildActual({
          tools: definition.tools.map((tool) => tool.name),
          model: profile.model,
          route: profile.route,
          systemPromptDigest: rpcChildPromptDigest(profile.systemPrompt),
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
      if (entry.failed) return
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
      let parent: ReturnType<RpcChildRegistryOptions['captureParent']>
      try {
        parent = this.options.captureParent(started)
      } catch {
        this.retire(entry)
        return
      }
      if (
        !parent ||
        !approvalIdentifier(parent.runId) ||
        this.cancelledParents.has(parent.runId) ||
        this.disposed ||
        entry.failed
      ) {
        this.retire(entry)
        return
      }
      entry.started = started
      entry.parentRunId = parent.runId
      this.join(entry)
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
        for (const resolve of [...entry.terminalWaiters]) resolve(entry.terminal)
        this.retire(entry)
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
  cancelChild(scope: RpcChildScope): void {
    const entry = this.entries.get(scope.nativeAgentId)
    if (entry?.scope && sameRpcChildScope(scope, entry.scope)) this.retire(entry)
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
    for (const entry of this.entries.values()) if (entry.parentRunId === runId) this.retire(entry)
  }
  snapshot(): readonly RpcChildRun[] {
    return Object.freeze(
      [...this.entries.values()].flatMap((entry) => (entry.run && !entry.failed ? [entry.run] : []))
    )
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
  }
  private entry(id: string): Entry | undefined {
    if (this.disposed) return undefined
    let entry = this.entries.get(id)
    if (!entry) {
      if (this.entries.size >= this.maximum) return undefined
      entry = {
        controller: new AbortController(),
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
      entry.started.detached
    ) {
      this.retire(entry)
      return
    }
    if (!entry.run && entry.waiters.size) {
      const profile = this.profiles.get(entry.scope.nativeName)!
      entry.run = Object.freeze({
        id: randomUUID(),
        parentRunId: entry.parentRunId,
        parentToolCallId: entry.started.parentToolCallId,
        scope: entry.scope,
        profile,
        signal: entry.controller.signal
      })
    }
    if (entry.run) for (const resolve of [...entry.waiters]) resolve(entry.run)
  }
  private retire(entry: Entry): void {
    if (entry.failed) return
    entry.failed = true
    entry.controller.abort()
    for (const resolve of [...entry.waiters]) resolve(undefined)
  }
}
