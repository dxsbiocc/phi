import { assertSafeBrowserHistory } from './browser-tool-stream'
import { publishRpcPromptPolicy } from './prompt-policy-publication'
import type { RpcPromptPolicy } from '../phi-extension/lib/rpc-prompt-policy'
import {
  assertRuntimeIdleState,
  requestRuntimeCompactionControl
} from './runtime-compaction-control'
import {
  compactionPolicy,
  type RpcCompactionPolicy,
  type RpcCompactionSummary
} from '../phi-extension/lib/rpc-compaction-control'
import type { RuntimeSelectionControl } from '../types'
import { confirmInitialThinking, type RuntimeInitialSelection } from './runtime-selection-control'
import { BrowserTextVault } from '../../browser/browser-text-vault'
import type { ContextUsageSnapshot } from '../../../../shared/contextUsageTypes'
import { randomBytes } from 'node:crypto'
import { createRuntimeMetadataControl, type RuntimeRenamePolicy } from './runtime-metadata-control'
import type { PhiTool, PhiToolImage, PhiToolApproval, PhiToolResult } from '../types'
import { executionRoster, type RpcExecutionTool } from '../phi-extension/lib/rpc-execution-protocol'
import type { RpcRuntimeConfig } from '../phi-extension/lib/rpc-runtime-config'
import { RpcConnection } from './connection'
import { RpcExecutionAuthority } from './execution-authority'
import {
  RpcApprovalBridge,
  type RpcApprovalBridgeOptions,
  type RpcApprovalEvent
} from './approval-bridge'
import { RpcHostToolBridge } from './host-tool-bridge'
import { RpcHostResultDelivery } from './host-result-delivery'
import { registeredHostTools } from './host-tool-validation'
import { readRemoteHistory, withRemoteSignal, type RemoteHistoryCheckpoint } from './history-pager'
import {
  prepareModelProxyRpcSessionTransport,
  type ModelProxyRpcTransportOptions,
  type ModelProxyRpcSessionTransport
} from './model-proxy-lease'
import { publishRpcRuntimeConfig } from './runtime-config'
import { attestRpcRuntime } from './runtime-attestation'
import {
  recoverRemoteSession,
  type RemoteRecoveryAction,
  type RemoteSessionRecoveryResult
} from './session-recovery'
import { createRpcSessionVerifier } from './session-verification'
import { preflightRemoteJournal } from './session-storage/remote-preflight'
import { publishRemoteSessionManifestOverRpc } from './session-manifest-publication'
import type { RemoteSessionStoragePreparation } from './session-storage/types'
import type { RpcSessionCreateParams } from './rpc-session-backend'
import type { RpcConnectionOptions, RpcPromptOptions, RpcPromptResult, RpcFrame } from './types'
import { createRpcRuntimeHostPolicy } from './runtime-host-policy'
import type { RpcHostToolRun } from './host-tool-bridge'
import type { SafeModelDescriptor } from '../model-gateway-types'
import type { PhiAgentDefinition, PhiAgentThinkingLevel } from '../../agents/definition'
import type { SessionRun } from '../../session/session-runner-registry'
import type {
  RpcAgentServerBinding,
  RpcAgentResourceCatalogInput,
  CompileRpcAgentDefinitionsOptions,
  RpcChildRunSnapshot
} from './subagents/types'
import type { RpcChildRun } from './subagents/run-registry'
import type { RpcChildCall } from '../phi-extension/lib/rpc-child-protocol'
import type { RpcChildWaitOptions, RpcChildWaitResult } from './subagents/child-run-controls'
import {
  createProductionChildConfig,
  publishProductionChildConfig,
  type PreparedProductionChildConfig
} from './subagents/production-child-config'
import { ProductionChildRuntime } from './subagents/production-child-runtime'
import { completedChildReport } from './subagents/child-report'
import { verifyRpcChildModelHeader } from '../phi-extension/lib/rpc-child-model-authority'
import { sameRpcChildScope } from '../phi-extension/lib/rpc-child-protocol'

export interface RemoteRuntimeSnapshot extends Omit<RemoteSessionRecoveryResult, 'modelPolicy'> {
  readonly modelPolicy: RemoteSessionRecoveryResult['modelPolicy'] | 'maintained'
  readonly sessionName?: string
}
export interface RemoteRuntimeTurnResult {
  /** An owned, confirmed stop can settle after SDK admission rejected without a prompt_result. */
  readonly result:
    | RpcPromptResult
    | { readonly type: 'runtime_stop'; readonly status: 'aborted'; readonly error?: never }
  readonly snapshot: RemoteRuntimeSnapshot
  /** Phi run state includes explicit policy denial even when SDK completes its error-result turn. */
  readonly outcome: 'completed' | 'failed' | 'aborted'
}
export interface RemoteSessionRuntimeOptions {
  readonly assertBinding?: () => void
  readonly promptPolicy?: Omit<
    RpcPromptPolicy,
    'schema' | 'nonce' | 'phiSessionId' | 'projectId' | 'projectRoot' | 'generation'
  >
  readonly compaction?: RpcCompactionPolicy
  readonly transport: Omit<ModelProxyRpcTransportOptions, 'prepareRuntime'>
  readonly params: RpcSessionCreateParams
  readonly action: RemoteRecoveryAction
  /** Only an explicit idle Phi selection supplies this; ordinary resume preserves journal policy. */
  readonly initialSelection?: RuntimeInitialSelection
  readonly sessionName?: string
  /** Genuine curated PhiTool instances supplied by the trusted facade. */
  readonly tools: readonly PhiTool[]
  readonly browserTextVault?: BrowserTextVault
  readonly hostApprovalFor?: (
    toolName: string,
    input: Readonly<Record<string, unknown>>
  ) => PhiToolApproval | undefined
  readonly nativeTools?: readonly (
    'read' | 'write' | 'edit' | 'bash' | 'powershell' | 'glob' | 'grep'
  )[]
  /** Explicit trusted foreground capability; absent retains the original task denial. */
  readonly foregroundChildren?: {
    readonly binding: RpcAgentServerBinding
    readonly definitions: readonly PhiAgentDefinition[]
    readonly aliases?: Readonly<Record<string, string>>
    readonly blockedAgents?: Readonly<
      Record<string, { readonly filePath: string; readonly contentHash: string }>
    >
    readonly allowParallel?: boolean
    readonly allowBackground?: boolean
    readonly resources?: RpcAgentResourceCatalogInput
    readonly resolveEnvironment?: CompileRpcAgentDefinitionsOptions['resolveEnvironment']
    readonly classifyTool?: (run: RpcChildRun, call: RpcChildCall) => PhiToolApproval | undefined
    readonly executeHost?: (
      run: RpcChildRun,
      call: RpcChildCall,
      signal: AbortSignal
    ) => Promise<PhiToolResult>
    readonly drainHost?: (childRunId?: string) => Promise<void>
    readonly onChildChange?: (snapshot: Readonly<RpcChildRunSnapshot>, parent: SessionRun) => void
    readonly onChildFinished?: (
      snapshot: Readonly<RpcChildRunSnapshot>,
      parent: SessionRun
    ) => void | Promise<void>
    readonly parentThinkingLevel: PhiAgentThinkingLevel
    readonly currentParentRun: () => SessionRun | undefined
    readonly onApprovalEvent?: (parent: SessionRun, event: RpcApprovalEvent) => void
  }
  readonly recentUserImages: () => PhiToolImage[]
  readonly approval: Pick<
    RpcApprovalBridgeOptions,
    'shouldGate' | 'requestToolApproval' | 'onEvent'
  > & { projectName?: string }
  /** Actual Phi manifest adoption. Caller must check its Phi generation/anchor and cancellation before committing. */
  readonly adopt: (snapshot: RemoteRuntimeSnapshot, signal: AbortSignal) => Promise<void>
  /** Acquire real Phi adoption authority before asynchronous proof; release on every exit. */
  readonly beforeCheckpoint?: (signal: AbortSignal) => () => void | Promise<void>
  readonly signal?: AbortSignal
  readonly connectionOptions?: RpcConnectionOptions
  readonly onInterrupted?: (error: Error) => void
}

/** Owns one real server process, registered writer, gateway and private generation. No facade stubs. */
export class RemoteSessionRuntime {
  private readonly connection: RpcConnection
  private readonly params: Readonly<RpcSessionCreateParams>
  private readonly lifetime = new AbortController()
  private transport!: ModelProxyRpcSessionTransport
  private storage?: RemoteSessionStoragePreparation
  private config?: RpcRuntimeConfig
  private modelDescriptors: readonly SafeModelDescriptor[] = []
  private delivery?: RpcHostResultDelivery
  private authority?: RpcExecutionAuthority
  private preparedChildren?: PreparedProductionChildConfig
  private children?: ProductionChildRuntime
  private readonly childVaults = new Map<string, BrowserTextVault>()
  private hostPolicy?: ReturnType<typeof createRpcRuntimeHostPolicy>
  private host?: RpcHostToolBridge
  private approvals?: RpcApprovalBridge
  private verifier?: ReturnType<typeof createRpcSessionVerifier>
  private preparedCleanup?: () => void | Promise<void>
  private snapshot?: RemoteRuntimeSnapshot
  private gate = true
  private ready = false
  private closing?: Promise<void>
  private pending?: Promise<RemoteRuntimeTurnResult>
  private promptController?: AbortController
  private promptRunId?: string
  private stopping?: Promise<void>
  private deniedRun?: string
  private readonly detach: Array<() => void> = []
  private selectionGuard?: RuntimeInitialSelection
  private manualCompaction?: Promise<{
    summary: RpcCompactionSummary
    snapshot: RemoteRuntimeSnapshot
  }>
  private manualController?: AbortController
  private manualCancelled = false
  private manualAbort?: Promise<void>
  private manualFailureClosing = false
  private readonly metadata = createRuntimeMetadataControl({
    signal: () => AbortSignal.any([this.lifetime.signal, this.connection.bindControl().signal]),
    claim: () => {
      if (
        !this.isReady ||
        this.pending ||
        this.authority?.currentRun() ||
        this.hasActiveAgentRuns()
      )
        throw new Error('Remote metadata requires an idle runtime')
      this.ready = false
      this.gate = true
      return () => {
        this.active()
        this.ready = true
        this.gate = false
      }
    },
    active: () => this.active(),
    snapshot: () => this.snapshot!,
    readState: () => this.connection.request({ type: 'get_state' }),
    setName: (name) => this.connection.request({ type: 'set_session_name', name }),
    checkpoint: (name) => this.checkpointUnderGate(name),
    withCheckpoint: (operation) => this.withCheckpoint(operation),
    close: (error) => this.close(error)
  })
  readContextUsage(): Promise<ContextUsageSnapshot | null> {
    return this.metadata.readContextUsage()
  }
  async assertIdle(control?: RuntimeSelectionControl): Promise<void> {
    control?.assertCurrent()
    if (!this.isReady || this.pending || this.authority?.currentRun() || this.hasActiveAgentRuns())
      throw new Error('Control requires an idle remote runtime')
    const state = await this.connection.request({ type: 'get_state' })
    control?.assertCurrent()
    if (!this.isReady) throw new Error('Remote generation changed during idle confirmation')
    assertRuntimeIdleState(state, this.snapshot!)
  }
  private async compactionPolicyUnderGate(
    snapshot = this.snapshot!,
    signal = this.lifetime.signal
  ): Promise<RpcCompactionPolicy> {
    if (!this.options.compaction || !this.config)
      throw new Error('Owned compaction policy is unavailable')
    const result = await requestRuntimeCompactionControl({
      connection: this.connection,
      identity: {
        nonce: this.config.nonce,
        phiSessionId: this.config.phiSessionId,
        generation: this.config.generation,
        ompSessionId: snapshot.reference.ompSessionId,
        journalPath: snapshot.checkpoint.journalPath
      },
      policy: this.options.compaction,
      operation: 'settings',
      signal,
      assertCurrent: this.active
    })
    this.active()
    return compactionPolicy(result.policy)
  }
  async readCompactionPolicy(): Promise<RpcCompactionPolicy> {
    await this.assertIdle()
    this.ready = false
    this.gate = true
    try {
      return await this.compactionPolicyUnderGate()
    } catch (error) {
      await this.interrupt(
        error instanceof Error ? error : new Error('Compaction policy readback failed')
      )
      throw error
    } finally {
      if (!this.closing) {
        this.ready = true
        this.gate = false
      }
    }
  }
  compact(
    control?: RuntimeSelectionControl
  ): Promise<{ summary: RpcCompactionSummary; snapshot: RemoteRuntimeSnapshot }> {
    if (!this.isReady || this.manualCompaction || this.pending || this.hasActiveAgentRuns())
      return Promise.reject(new Error('Compaction requires an idle remote runtime'))
    this.ready = false
    this.gate = true
    this.manualCancelled = false
    this.manualAbort = undefined
    const manualController = new AbortController()
    this.manualController = manualController
    const controlSignal = AbortSignal.any([this.lifetime.signal, manualController.signal])
    let began = false
    const assertCurrent = (): void => {
      this.active()
      control?.assertCurrent()
      if (this.manualCancelled) throw new Error('Owned compaction cancelled')
    }
    const operation = Promise.resolve()
      .then(() =>
        this.withCheckpoint(async () => {
          assertCurrent()
          assertRuntimeIdleState(
            await this.connection.request({ type: 'get_state' }),
            this.snapshot!
          )
          assertCurrent()
          began = true
          const policy = await this.compactionPolicyUnderGate(this.snapshot!, controlSignal)
          assertCurrent()
          const result = await requestRuntimeCompactionControl({
            connection: this.connection,
            identity: {
              nonce: this.config!.nonce,
              phiSessionId: this.config!.phiSessionId,
              generation: this.config!.generation,
              ompSessionId: this.snapshot!.reference.ompSessionId,
              journalPath: this.snapshot!.checkpoint.journalPath
            },
            policy,
            operation: 'compact',
            signal: controlSignal,
            assertCurrent
          })
          assertCurrent()
          if (!result.summary) throw new Error('Compaction summary is missing')
          await this.compactionPolicyUnderGate(this.snapshot!, controlSignal)
          assertCurrent()
          const snapshot = await this.checkpointUnderGate()
          assertCurrent()
          return { summary: result.summary, snapshot }
        })
      )
      .then((result) => {
        assertCurrent()
        this.ready = true
        this.gate = false
        return result
      })
      .catch(async (error: unknown) => {
        await this.manualAbort?.catch(() => undefined)
        if (!began && !this.closing && !this.manualCancelled) {
          this.ready = true
          this.gate = false
        } else if (!this.closing) {
          this.manualFailureClosing = true
          await this.close(error)
        }
        throw error
      })
      .finally(() => {
        if (this.manualCompaction === operation) this.manualCompaction = undefined
        this.manualController = undefined
        this.manualFailureClosing = false
        this.options.browserTextVault?.clear()
      })
    this.manualCompaction = operation
    void operation.catch(() => undefined)
    return operation
  }
  async readThinkingLevels(): Promise<readonly string[]> {
    if (!this.isReady || this.pending || this.authority?.currentRun())
      throw new Error('Remote selection requires an idle runtime')
    const result = await this.connection.request<{ levels?: unknown }>({
      type: 'get_available_thinking_levels'
    })
    if (
      !this.isReady ||
      !Array.isArray(result.levels) ||
      !result.levels.every((level) => typeof level === 'string')
    )
      throw new Error('Remote SDK returned invalid thinking levels')
    return result.levels
  }
  rename(name: string, policy?: RuntimeRenamePolicy): Promise<RemoteRuntimeSnapshot> {
    return this.metadata.rename(name, policy)
  }
  private constructor(private readonly options: RemoteSessionRuntimeOptions) {
    this.selectionGuard = options.initialSelection
    if (options.foregroundChildren)
      this.options = Object.freeze({
        ...options,
        foregroundChildren: Object.freeze({
          ...options.foregroundChildren,
          binding: Object.freeze({ ...options.foregroundChildren.binding }),
          definitions: Object.freeze(structuredClone(options.foregroundChildren.definitions)),
          aliases:
            options.foregroundChildren.aliases &&
            Object.freeze({ ...options.foregroundChildren.aliases }),
          blockedAgents:
            options.foregroundChildren.blockedAgents &&
            Object.freeze(structuredClone(options.foregroundChildren.blockedAgents))
        })
      })
    this.params = Object.freeze({
      ...options.params,
      ...(options.params.model ? { model: Object.freeze({ ...options.params.model }) } : {})
    })
    this.connection = new RpcConnection(
      (signal, generation) => this.transport.open(this.params, signal, generation),
      options.connectionOptions
    )
    this.detach.push(
      this.connection.onDisconnect(({ error, expected }) => {
        if (!expected) {
          void this.interrupt(error).catch(() => undefined)
        }
      })
    )
    if (options.signal) {
      const abort = (): void => {
        void this.close(options.signal!.reason)
      }
      options.signal.addEventListener('abort', abort, { once: true })
      this.detach.push(() => options.signal!.removeEventListener('abort', abort))
      if (options.signal.aborted) abort()
    }
  }
  static async create(options: RemoteSessionRuntimeOptions): Promise<RemoteSessionRuntime> {
    const runtime = new RemoteSessionRuntime(options)
    try {
      await runtime.initialize()
      runtime.selectionGuard = undefined
      return runtime
    } catch (error) {
      await runtime.close(error)
      throw error
    }
  }
  get isReady(): boolean {
    return (
      this.ready &&
      !this.gate &&
      !this.lifetime.signal.aborted &&
      this.host?.isReady === true &&
      this.connection.isReady
    )
  }
  /** Trusted facade event stream. The controller remains the sole ordinary prompt/checkpoint owner. */
  onEvent(listener: (frame: RpcFrame) => void): () => void {
    return this.connection.onEvent(listener)
  }
  currentRun(): RpcHostToolRun | undefined {
    return this.hostPolicy?.currentRun()
  }
  hasActiveAgentRuns(): boolean {
    return this.children?.hasActiveChildren() ?? false
  }
  childRunForHost(id: string): RpcChildRun | undefined {
    return this.children?.childRunForHost(id)
  }
  childBrowserTextVault(id: string): BrowserTextVault {
    const run = this.childRunForHost(id)
    if (!run) throw new Error('Child privacy authority is unavailable')
    let vault = this.childVaults.get(run.id)
    if (!vault) {
      vault = new BrowserTextVault({ allowTypeText: false })
      this.childVaults.set(run.id, vault)
    }
    return vault
  }
  childResourceOwner(id: string): {
    readonly toolOwner: string
    readonly allowedSkills: readonly string[]
  } {
    const run = this.childRunForHost(id)
    const profile =
      run &&
      this.preparedChildren?.config.profiles.find(
        (entry) => entry.definition.nativeName === run.scope.nativeName
      )
    if (!profile) throw new Error('Child resource owner is unavailable')
    return Object.freeze({
      toolOwner: profile.definition.phiName,
      allowedSkills: Object.freeze([...profile.definition.skills])
    })
  }
  listChildRuns(): readonly Readonly<RpcChildRunSnapshot>[] {
    return this.children?.listRuns() ?? []
  }
  steerChild(id: string, message: string, signal?: AbortSignal): Promise<void> {
    if (!this.children) return Promise.reject(new Error('Child controls are unavailable'))
    return this.children.steer(id, message, signal)
  }
  stopChild(id: string, signal?: AbortSignal): Promise<Readonly<RpcChildRunSnapshot>> {
    if (!this.children) return Promise.reject(new Error('Child controls are unavailable'))
    return this.children.stopChild(id, signal)
  }
  waitForChildren(options: RpcChildWaitOptions): Promise<RpcChildWaitResult> {
    if (!this.children) return Promise.reject(new Error('Child controls are unavailable'))
    return this.children.wait(options)
  }
  awaitChildCompletionDelivery(id: string): Promise<void> {
    if (!this.children) return Promise.reject(new Error('Child completion delivery is unavailable'))
    return this.children.awaitChildCompletionDelivery(id)
  }
  async readChildReport(run: Readonly<RpcChildRunSnapshot>, signal?: AbortSignal): Promise<string> {
    const known = this.children?.status(run.id)
    if (!known || known.nativeId !== run.nativeId || known.completedAt === undefined)
      throw new Error('Child report is not owned by this generation')
    if (known.status !== 'completed') return ''
    const result = await withRemoteSignal(
      this.connection.request<{ messages: unknown[] }>({
        type: 'get_subagent_messages',
        subagentId: known.nativeId
      }),
      AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    )
    if (!Array.isArray(result.messages)) throw new Error('Child report is unavailable')
    return completedChildReport(result.messages)
  }
  currentSnapshot(): RemoteRuntimeSnapshot {
    if (!this.snapshot || !this.isReady) throw new Error('Remote runtime is not ready')
    return this.snapshot
  }
  private active = (): void => {
    this.selectionGuard?.assertCurrent()
    this.lifetime.signal.throwIfAborted()
    this.options.assertBinding?.()
    if (this.closing) throw new Error('Remote runtime is closing')
    this.storage?.lease.assertActive()
    if (!this.gate || this.authority?.currentRun())
      throw new Error('Remote runtime checkpoint requires an exclusive idle gate')
  }
  private async withCheckpoint<T>(operation: () => Promise<T>): Promise<T> {
    this.active()
    const release = this.options.beforeCheckpoint?.(this.lifetime.signal)
    let result!: T
    let failed = false,
      primary: unknown
    let cleanupFailed = false,
      cleanupError: unknown
    try {
      this.active()
      result = await operation()
    } catch (error) {
      failed = true
      primary = error
    } finally {
      try {
        await release?.()
      } catch (error) {
        cleanupFailed = true
        cleanupError = error
      }
    }
    if (failed) throw primary
    if (cleanupFailed) throw cleanupError
    return result
  }

  private async initialize(): Promise<void> {
    await this.withCheckpoint(() => this.initializeCheckpoint())
    this.active()
    this.ready = true
    this.gate = false
  }
  private async initializeCheckpoint(): Promise<void> {
    const { options } = this
    const step = <T>(name: string, operation: () => Promise<T>): Promise<T> =>
      options.transport.startupDiagnostics?.step(name, operation) ?? operation()
    this.hostPolicy = createRpcRuntimeHostPolicy({
      tools: options.tools,
      currentRun: () => this.authority?.currentRun(),
      identity: () => this.authority!.sessionIdentity(),
      signal: this.lifetime.signal,
      approval: options.approval,
      hostApprovalFor: options.hostApprovalFor,
      onDenied: (runId) => {
        this.deniedRun = runId
      }
    })
    const registered = registeredHostTools(options.tools)
    const nativeTools = Object.freeze([
      ...(options.nativeTools ?? (['read', 'write', 'edit', 'bash'] as const)),
      ...(options.foregroundChildren ? (['task'] as const) : [])
    ])
    const tools = Object.freeze([...registered.values()].map(({ tool }) => tool))
    const roster: readonly RpcExecutionTool[] = executionRoster(
      [
        ...nativeTools.map((name) => ({
          name,
          site: 'native' as const
        })),
        ...[...registered.values()].map(({ definition }) => ({
          name: definition.name,
          site: 'host' as const,
          parameters: definition.parameters
        }))
      ],
      { allowNativeTask: options.foregroundChildren !== undefined }
    ).tools
    if (!options.transport.preparePersistentStorage)
      throw new Error('Remote runtime requires registered persistent storage')
    this.transport = await prepareModelProxyRpcSessionTransport(
      {
        ...options.transport,
        browserTextVault: options.browserTextVault,
        assertSelectionCurrent: this.active,
        beforeLaunch: this.active,
        currentBrowserRunSignal: () =>
          this.promptController?.signal ?? this.manualController?.signal,
        resolveBrowserChildRun: (header) => {
          try {
            this.lifetime.signal.throwIfAborted()
            this.options.assertBinding?.()
          } catch {
            return undefined
          }
          if (!this.preparedChildren || !this.children) return undefined
          const scope = verifyRpcChildModelHeader(header, this.preparedChildren.config.capability)
          const run = scope && this.children.childRunForHost(scope.nativeAgentId)
          if (!scope || !run || run.signal.aborted || !sameRpcChildScope(scope, run.scope))
            return undefined
          return {
            signal: run.signal,
            modelSignal: run.modelSignal,
            vault: this.childBrowserTextVault(run.id)
          }
        },
        prepareRuntime: async (context) => {
          this.lifetime.signal.throwIfAborted()
          if (!context.storage) throw new Error('Remote runtime requires persistent launch storage')
          this.storage = context.storage
          this.modelDescriptors = context.modelDescriptors
          const executionCapability = randomBytes(32).toString('hex'),
            resultCapability = randomBytes(32).toString('hex'),
            leaseId = randomBytes(32).toString('hex')
          if (options.foregroundChildren) {
            const parentModel = context.params.model
            if (!parentModel) throw new Error('Child runtime requires its parent model')
            await step('child_publication', async () => {
              this.preparedChildren = await createProductionChildConfig({
                identity: {
                  nonce: context.bootstrap.nonce,
                  phiSessionId: context.params.sessionId,
                  projectId: context.bootstrap.projectId,
                  projectRoot: context.params.cwd,
                  generation: context.generation
                },
                binding: options.foregroundChildren!.binding,
                definitions: options.foregroundChildren!.definitions,
                aliases: options.foregroundChildren!.aliases,
                blockedAgents: options.foregroundChildren!.blockedAgents,
                availableTools: [
                  ...roster
                    .filter((tool) => tool.site === 'native' && tool.name !== 'task')
                    .map(({ name, site }) => ({ name, site })),
                  ...(options.foregroundChildren!.resources?.hostTools ?? []).map(({ name }) => ({
                    name,
                    site: 'host' as const
                  }))
                ],
                availableSkills: options.foregroundChildren!.resources?.skills.map(
                  ({ name }) => name
                ),
                resources: options.foregroundChildren!.resources,
                resolveEnvironment: options.foregroundChildren!.resolveEnvironment,
                allowBackground: options.foregroundChildren!.allowBackground,
                allowParallel: options.foregroundChildren!.allowParallel,
                modelDescriptors: context.modelDescriptors,
                parentModel: options.initialSelection?.model ?? parentModel,
                parentThinkingLevel: options.foregroundChildren!.parentThinkingLevel,
                native: context.native,
                otherCapabilities: [executionCapability, resultCapability]
              })
              await publishProductionChildConfig({
                prepared: this.preparedChildren,
                context,
                host: options.transport.runtime.runtimeHost,
                uploadOptions: options.transport.runtime.uploadOptions
              })
            })
          }
          this.delivery = await step('host_delivery_publication', () =>
            RpcHostResultDelivery.create({
              host: options.transport.runtime.runtimeHost,
              generationDirectory: context.generationDirectory,
              lease: {
                leaseId,
                generation: context.generation,
                phiSessionId: context.params.sessionId,
                projectId: context.bootstrap.projectId,
                cwd: context.params.cwd
              },
              capability: resultCapability,
              startup: context.startup,
              signal: context.signal,
              uploadOptions: options.transport.runtime.uploadOptions
            })
          )
          const promptPolicyHash = options.promptPolicy
            ? await step('prompt_policy_publication', () =>
                publishRpcPromptPolicy({
                  context,
                  runtime: options.transport.runtime,
                  policy: options.promptPolicy!,
                  assertCurrent: this.active
                })
              )
            : undefined
          context.signal.throwIfAborted()
          this.active()
          this.config = Object.freeze({
            ...(promptPolicyHash ? { promptPolicyHash } : {}),
            schema: 1,
            nonce: context.bootstrap.nonce,
            phiSessionId: context.params.sessionId,
            projectId: context.bootstrap.projectId,
            projectRoot: context.params.cwd,
            generation: context.generation,
            ...(this.preparedChildren ? { childRuntimeRequired: true } : {}),
            activeTools: Object.freeze(
              roster
                .filter(
                  (tool) => tool.site === 'native' || !registered.get(tool.name)?.definition.hidden
                )
                .map((tool) => tool.name)
            ),
            hiddenTools: Object.freeze(
              [...registered.values()]
                .filter(({ definition }) => definition.hidden)
                .map(({ definition }) => definition.name)
            ),
            generationDirectory: context.generationDirectory,
            directory: context.storage.paths.directory,
            journals: context.storage.paths.journals,
            blobs: context.storage.paths.blobs,
            execution: Object.freeze({ capability: executionCapability, tools: roster }),
            result: Object.freeze({
              capability: resultCapability,
              leaseId,
              directory: this.delivery.directory
            }),
            native: context.native
          })
          await step('runtime_config_publication', () =>
            publishRpcRuntimeConfig({
              context,
              host: options.transport.runtime.runtimeHost,
              config: this.config!,
              uploadOptions: options.transport.runtime.uploadOptions
            })
          )
          return {
            ...(options.compaction ? { compaction: options.compaction } : {}),
            nativeTools,
            ...(this.preparedChildren
              ? {
                  childRuntimeRequired: true,
                  childBackgroundEnabled:
                    this.preparedChildren.config.policy.allowBackground === true,
                  childParallelEnabled: this.preparedChildren.config.policy.allowParallel === true,
                  foregroundChildNativeNames: Object.freeze(
                    this.preparedChildren.config.profiles.map(
                      (profile) => profile.definition.nativeName
                    )
                  )
                }
              : {})
          }
        }
      },
      this.lifetime.signal
    )
    const cleanup = await this.transport.prepare(this.params, this.lifetime.signal)
    if (typeof cleanup === 'function') this.preparedCleanup = cleanup
    if (this.lifetime.signal.aborted) await this.preparedCleanup?.()
    this.lifetime.signal.throwIfAborted()
    this.active()
    await this.connection.start()
    this.active()
    await this.transport.initialize({
      connection: this.connection,
      params: this.params,
      signal: this.lifetime.signal
    })
    this.active()
    if (!this.config || !this.storage || !this.delivery)
      throw new Error('Missing composed runtime launch')
    const { config, storage } = this
    const control = this.connection.bindControl()
    if (config.generation !== control.generation)
      throw new Error('Composed runtime channel generation differs')
    this.verifier = createRpcSessionVerifier({
      connection: this.connection,
      control,
      identity: {
        nonce: config.nonce,
        phiSessionId: config.phiSessionId,
        projectId: config.projectId,
        generation: config.generation,
        projectRoot: config.projectRoot,
        directory: config.directory,
        journals: config.journals,
        blobs: config.blobs
      },
      assertActive: this.active
    })
    let startupPreflight = this.transport.startupPreflight(this.params)
    const result = await recoverRemoteSession({
      action: options.action,
      storage,
      connection: this.connection,
      control,
      signal: this.lifetime.signal,
      availableModels: options.transport.models,
      preflight: (reference) => {
        if (startupPreflight) {
          const proof = startupPreflight
          startupPreflight = undefined
          return Promise.resolve(proof)
        }
        return step('journal_preflight', () => preflightRemoteJournal(storage, reference))
      },
      verifySavedState: (reference, signal) =>
        step('journal_saved_state', () => this.verifier!.verifySavedState(reference, signal)),
      selectModel: async (_reference, selection, signal) => {
        await this.transport.selectModel(
          { connection: this.connection, params: this.params, signal },
          { ...this.params.model!, ...selection.model }
        )
        this.active()
        if (!options.initialSelection && selection.policy === 'fresh' && this.params.thinkingLevel)
          await this.connection.request({
            type: 'set_thinking_level',
            level: this.params.thinkingLevel
          })
      },
      verifyAttachment: async (identity, signal) => {
        if (!this.authority) {
          this.host = await RpcHostToolBridge.create({
            connection: this.connection,
            tools,
            scope: {
              sessionId: config.phiSessionId,
              projectId: config.projectId,
              cwd: config.projectRoot,
              recentUserImages: options.recentUserImages,
              currentRun: () => this.hostPolicy?.currentRun()
            },
            signal,
            resultDelivery: this.delivery,
            onError: (error) => this.interrupt(error)
          })
          await step('runtime_attestation', () =>
            attestRpcRuntime(this.connection, config, identity.ompSessionId, signal)
          )
          this.approvals = new RpcApprovalBridge({
            ...options.approval,
            connection: this.connection,
            scope: {
              nonce: config.nonce,
              phiSessionId: config.phiSessionId,
              projectId: config.projectId,
              cwd: config.projectRoot,
              ompSessionId: identity.ompSessionId,
              projectName: options.approval.projectName,
              currentRun: () => this.authority?.currentRun()
            },
            signal,
            onEvent: async (event) => {
              if (event.type === 'approval_denied') this.deniedRun = event.runId
              await options.approval.onEvent?.(event)
            },
            onError: (error) => this.interrupt(error)
          })
          this.authority = await RpcExecutionAuthority.create({
            connection: this.connection,
            identity: {
              nonce: config.nonce,
              phiSessionId: config.phiSessionId,
              projectId: config.projectId,
              cwd: config.projectRoot,
              generation: control.generation
            },
            capability: config.execution.capability,
            roster,
            allowNativeTask: this.preparedChildren !== undefined,
            signal
          })
        }
        const verified = await step('attachment_verification', () =>
          this.verifier!.verifyAttachment(identity, signal)
        )
        if (!options.initialSelection) await this.attachForegroundChildren(identity)
        return verified
      },
      publish: async (reference, _checkpoint, signal) => {
        await step('manifest_publication', () =>
          publishRemoteSessionManifestOverRpc({
            connection: this.connection,
            control,
            identity: {
              nonce: config.nonce,
              phiSessionId: config.phiSessionId,
              projectId: config.projectId,
              generation: config.generation,
              projectRoot: config.projectRoot,
              directory: config.directory,
              journals: config.journals,
              blobs: config.blobs
            },
            reference,
            signal,
            assertActive: this.active
          })
        )
      },
      interrupt: (error) => this.close(error)
    })
    this.active()
    assertSafeBrowserHistory(result.messages)
    if (options.initialSelection) {
      this.snapshot = result
      this.active()
      if (
        result.modelPolicy !== 'restored' ||
        result.model.provider !== options.initialSelection.model.provider ||
        result.model.id !== options.initialSelection.model.id
      ) {
        await this.transport.selectModel(
          { connection: this.connection, params: this.params, signal: this.lifetime.signal },
          options.initialSelection.model
        )
        this.active()
      }
      await confirmInitialThinking(
        this.connection,
        options.initialSelection.model,
        options.initialSelection,
        this.lifetime.signal
      )
      await this.attachForegroundChildren({
        ompSessionId: result.reference.ompSessionId,
        journalPath: result.checkpoint.journalPath
      })
      this.active()
      if (options.compaction) await this.compactionPolicyUnderGate(result)
      const selection = {
        model: {
          provider: options.initialSelection.model.provider,
          id: options.initialSelection.model.id
        },
        thinkingLevel: options.initialSelection.thinkingLevel
      }
      if (options.sessionName !== undefined)
        await this.metadata.reconcileInitialName(options.sessionName, { ...result, ...selection })
      await this.checkpointUnderGate(options.sessionName, selection)
      return
    }
    if (options.compaction) await this.compactionPolicyUnderGate(result)
    if (options.sessionName !== undefined) {
      await this.metadata.reconcileInitialName(options.sessionName, result)
      this.snapshot = result
      await this.checkpointUnderGate(options.sessionName)
      return
    }
    await step('phi_adoption', () =>
      withRemoteSignal(
        Promise.resolve().then(() => {
          this.active()
          return options.adopt(result, this.lifetime.signal)
        }),
        this.lifetime.signal
      )
    )
    this.active()
    const final = await step('adoption_verification', () => this.verifyCurrent(result))
    if (
      final.leafId !== result.checkpoint.leafId ||
      final.messageCount !== result.checkpoint.messageCount
    )
      throw new Error('Remote initialization checkpoint changed during adoption')
    this.verifier.commitAttachment()
    this.snapshot = result
  }
  private async attachForegroundChildren(identity: {
    ompSessionId: string
    journalPath: string
  }): Promise<void> {
    const { options } = this
    if (options.foregroundChildren && !this.children) {
      if (!this.preparedChildren) throw new Error('Child runtime publication is unavailable')
      this.children = await ProductionChildRuntime.create({
        connection: this.connection,
        execution: this.authority!,
        prepared: this.preparedChildren,
        root: {
          rootOmpSessionId: identity.ompSessionId,
          rootSessionFile: identity.journalPath
        },
        currentParentRun: options.foregroundChildren.currentParentRun,
        approval: {
          ...options.approval,
          classifyTool: options.foregroundChildren.classifyTool,
          onEvent: (event) => {
            const parent = this.children?.parentForChild(event.runId)
            if (!parent) throw new Error('Child approval has no captured Phi parent')
            try {
              options.foregroundChildren?.onApprovalEvent?.(parent, event)
            } catch (error) {
              void this.interrupt(
                error instanceof Error ? error : new Error('Child approval persistence failed')
              ).catch(() => undefined)
              throw error
            }
          }
        },
        onDenied: (parent) => {
          this.deniedRun = parent.runId
        },
        onError: (error) => {
          void this.interrupt(error).catch(() => undefined)
        },
        executeHost: options.foregroundChildren.executeHost
          ? async (run, call, requestId, signal) => {
              const result = await options.foregroundChildren!.executeHost!(run, call, signal)
              return this.delivery!.publish(
                result,
                {
                  runId: run.id,
                  invocationId: requestId,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName
                },
                signal
              )
            }
          : undefined,
        hostResultConsumed: (run, call) => this.delivery!.consumed(run.id, call.toolCallId),
        drainHost: options.foregroundChildren.drainHost,
        onChildChange: (snapshot, parent) => {
          try {
            options.foregroundChildren?.onChildChange?.(snapshot, parent)
          } finally {
            if (snapshot.completedAt !== undefined) {
              this.childVaults.get(snapshot.id)?.clear()
              this.childVaults.delete(snapshot.id)
            }
          }
        },
        onChildFinished: async (snapshot, parent) => {
          try {
            await options.foregroundChildren?.onChildFinished?.(snapshot, parent)
          } finally {
            this.childVaults.get(snapshot.id)?.clear()
            this.childVaults.delete(snapshot.id)
          }
        },
        signal: this.lifetime.signal
      })
    }
  }
  private async verifyCurrent(snapshot: RemoteRuntimeSnapshot): Promise<
    RemoteHistoryCheckpoint & {
      readonly journalFileIdentity: string
      readonly journalDigest: string
    }
  > {
    this.active()
    const proof = await this.verifier!.verifyAttachment(snapshot.checkpoint, this.lifetime.signal)
    const state = await this.connection.request<{
      sessionId: string
      sessionFile: string
      messageCount: number
      model: {
        provider: string
        id: string
        contextWindow: number | null
        maxTokens: number | null
      }
      thinkingLevel?: string
      sessionName?: string
    }>({ type: 'get_state' })
    this.active()
    const expected = this.modelDescriptors.find(
      (model) => model.provider === snapshot.model.provider && model.id === snapshot.model.id
    )
    if (
      state.sessionId !== snapshot.reference.ompSessionId ||
      state.sessionFile !== snapshot.checkpoint.journalPath ||
      state.model?.provider !== snapshot.model.provider ||
      state.model?.id !== snapshot.model.id ||
      !expected ||
      state.model.contextWindow !== expected.contextWindow ||
      state.model.maxTokens !== expected.maxTokens ||
      state.thinkingLevel !== snapshot.thinkingLevel ||
      (snapshot.sessionName !== undefined && state.sessionName !== snapshot.sessionName) ||
      !Number.isSafeInteger(state.messageCount) ||
      state.messageCount < 0
    )
      throw new Error('Remote checkpoint/model policy changed')
    return Object.freeze({
      ...snapshot.checkpoint,
      leafId: proof.leafId,
      messageCount: state.messageCount,
      journalFileIdentity: proof.journalFileIdentity,
      journalDigest: proof.journalDigest
    })
  }
  async prompt(
    runId: string,
    text: string,
    options?: RpcPromptOptions,
    signal?: AbortSignal
  ): Promise<RemoteRuntimeTurnResult> {
    if (!this.isReady || this.pending || !this.authority)
      throw new Error('Remote runtime cannot admit this prompt')
    this.ready = false
    this.gate = false
    const controller = new AbortController()
    this.promptController = controller
    this.promptRunId = runId
    this.deniedRun = undefined
    // UI stops the real SessionRun first. Revoke permits immediately, but keep the
    // owned execution/channel alive until every native child confirms cancellation.
    const abort = (): void => {
      void this.stopExecution().catch((error: unknown) => {
        void this.interrupt(error instanceof Error ? error : new Error('Remote stop failed'))
      })
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const operation = Promise.resolve().then(async () => {
      await this.authority!.beginRun(runId, controller.signal)
      let result: RemoteRuntimeTurnResult['result']
      try {
        result = await this.authority!.prompt(text, options, async (received) => {
          if (received.status !== 'aborted' && !controller.signal.aborted)
            await this.children?.awaitParentPromptSettled(runId, this.lifetime.signal)
        })
      } catch (error) {
        if (!this.stopping) throw error
        await this.stopping
        if (!controller.signal.aborted || !this.children?.needsGenerationRetirement(runId))
          throw error
        result = { type: 'runtime_stop', status: 'aborted' }
      }
      await this.stopping
      if (controller.signal.aborted || result.status === 'aborted')
        this.children?.assertParentSettled(runId)
      this.gate = true
      const snapshot = await this.checkpoint()
      this.active()
      const executionAborted = controller.signal.aborted || result.status === 'aborted'
      if (this.children?.needsGenerationRetirement(runId))
        await this.close(new Error('Confirmed unspawned task requires a fresh runtime generation'))
      else {
        this.ready = true
        this.gate = false
      }
      return {
        result,
        snapshot,
        outcome: executionAborted
          ? ('aborted' as const)
          : result.status === 'error' || this.deniedRun === runId
            ? ('failed' as const)
            : ('completed' as const)
      }
    })
    this.pending = operation
    try {
      return await operation
    } catch (error) {
      await this.close(error)
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.options.browserTextVault?.clear()
      if (this.pending === operation) this.pending = undefined
      if (this.promptController === controller) {
        this.promptController = undefined
        this.promptRunId = undefined
        this.stopping = undefined
      }
    }
  }
  private checkpoint(): Promise<RemoteRuntimeSnapshot> {
    return this.withCheckpoint(() => this.checkpointUnderGate())
  }
  private async checkpointUnderGate(
    sessionName?: string,
    selection?: Pick<RemoteRuntimeSnapshot, 'model' | 'thinkingLevel'>
  ): Promise<RemoteRuntimeSnapshot> {
    this.active()
    const old = {
      ...this.snapshot!,
      ...selection,
      ...(sessionName === undefined ? {} : { sessionName })
    }
    const checkpoint = await this.verifyCurrent(old)
    const messages = await readRemoteHistory({
      connection: this.connection,
      control: this.connection.bindControl(),
      checkpoint,
      signal: this.lifetime.signal,
      readCheckpoint: () => this.verifyCurrent(old)
    })
    assertSafeBrowserHistory(messages)
    const after = await this.verifyCurrent(old)
    if (
      checkpoint.journalFileIdentity !== after.journalFileIdentity ||
      checkpoint.journalDigest !== after.journalDigest
    )
      throw new Error('Remote journal changed during checkpoint')
    const snapshot = Object.freeze({
      ...old,
      checkpoint,
      messages,
      modelPolicy: 'maintained' as const
    })
    await publishRemoteSessionManifestOverRpc({
      connection: this.connection,
      control: this.connection.bindControl(),
      identity: {
        nonce: this.config!.nonce,
        phiSessionId: this.config!.phiSessionId,
        projectId: this.config!.projectId,
        generation: this.config!.generation,
        projectRoot: this.config!.projectRoot,
        directory: this.config!.directory,
        journals: this.config!.journals,
        blobs: this.config!.blobs
      },
      reference: old.reference,
      signal: this.lifetime.signal,
      assertActive: this.active
    })
    await withRemoteSignal(
      Promise.resolve().then(() => {
        this.active()
        return this.options.adopt(snapshot, this.lifetime.signal)
      }),
      this.lifetime.signal
    )
    this.active()
    const final = await this.verifyCurrent(snapshot)
    if (final.leafId !== checkpoint.leafId || final.messageCount !== checkpoint.messageCount)
      throw new Error('Remote checkpoint changed during adoption')
    this.verifier!.commitAttachment()
    this.snapshot = snapshot
    return snapshot
  }
  async stop(): Promise<void> {
    if (this.manualCompaction) {
      const pending = this.manualCompaction,
        controller = this.manualController
      this.manualCancelled = true
      this.manualAbort ??= this.connection.abort()
      try {
        await this.manualAbort
      } catch (error) {
        await this.close(error)
        throw error
      }
      controller?.abort(new Error('Owned compaction cancelled after SDK stop acknowledgement'))
      await pending
      return
    }
    await this.stopExecution()
    await this.pending
  }
  private stopExecution(): Promise<void> {
    if (this.stopping) return this.stopping
    const runId = this.promptRunId,
      controller = this.promptController
    if (!runId || !controller) return Promise.resolve()
    let resolve!: () => void, reject!: (error: unknown) => void
    const stopping = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    this.stopping = stopping
    void stopping.catch(() => undefined)
    try {
      // Publish ownership before a pending UI's synchronous abort listener reenters.
      if (this.authority?.currentRun()?.id === runId) this.authority.revokeRun(runId)
      void (async () => {
        await this.children?.stopParent(runId)
        await this.authority?.cancelRun()
        controller.abort(new Error('Phi run stopped'))
      })().then(resolve, reject)
    } catch (error) {
      reject(error)
    }
    return stopping
  }
  private interrupt(error: Error): Promise<void> {
    if (this.closing) return this.closing
    // Revoke the complete generation before a diagnostic observer can reenter.
    // The same cleanup promise coalesces bridge failures and transport EOF.
    const cleanup = this.close(error)
    try {
      void Promise.resolve(this.options.onInterrupted?.(error)).catch(() => undefined)
    } catch {
      // Diagnostic observers cannot prevent owned resource retirement.
    }
    return cleanup
  }
  close(reason: unknown = new Error('Remote runtime closed')): Promise<void> {
    if (this.closing) return this.closing
    this.ready = false
    this.gate = true
    this.closing = Promise.resolve().then(async () => {
      let stopError: unknown,
        stopFailed = false
      try {
        await stopped
      } catch (error) {
        stopFailed = true
        stopError = error
      }
      try {
        if (
          this.children &&
          !this.connection.isClosed &&
          !this.connection.bindControl().signal.aborted
        ) {
          const parents = new Set(
            this.children
              .listRuns()
              .filter((run) => run.completedAt === undefined)
              .map((run) => run.parentRunId)
          )
          const results = await Promise.allSettled(
            [...parents].map((parent) =>
              Promise.resolve().then(() => this.children!.stopParent(parent))
            )
          )
          const failed = results.find((result) => result.status === 'rejected')
          if (failed?.status === 'rejected') throw failed.reason
        }
      } catch (error) {
        if (!stopFailed) {
          stopFailed = true
          stopError = error
        }
      }
      try {
        if (this.manualCompaction) {
          const pending = this.manualCompaction,
            controller = this.manualController
          this.manualCancelled = true
          this.manualAbort ??= this.connection.abort()
          let failed = false,
            failure: unknown
          try {
            await this.manualAbort
          } catch (error) {
            failed = true
            failure = error
            await this.connection.close()
          }
          controller?.abort(reason)
          if (!this.manualFailureClosing) await pending.catch(() => undefined)
          if (failed) throw failure
        }
      } catch (error) {
        if (!stopFailed) {
          stopFailed = true
          stopError = error
        }
      }
      this.lifetime.abort(reason)
      for (const detach of this.detach.splice(0)) detach()
      this.children?.dispose()
      for (const vault of this.childVaults.values()) vault.clear()
      this.childVaults.clear()
      try {
        await this.options.foregroundChildren?.drainHost?.()
      } catch (error) {
        if (!stopFailed) {
          stopFailed = true
          stopError = error
        }
      }
      this.approvals?.dispose()
      this.host?.dispose()
      await Promise.allSettled([
        this.delivery?.dispose(),
        this.authority?.dispose(),
        this.connection.close(),
        Promise.resolve().then(() => this.preparedCleanup?.())
      ])
      if (stopFailed) throw stopError
    })
    void this.closing.catch(() => undefined)
    // Permit revocation remains synchronous; cleanup ownership is already visible.
    const stopped = this.stopExecution()
    return this.closing
  }
}
