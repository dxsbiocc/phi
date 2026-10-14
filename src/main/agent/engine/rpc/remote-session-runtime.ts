import type { ContextUsageSnapshot } from '../../../../shared/contextUsageTypes'
import { randomBytes } from 'node:crypto'
import { createRuntimeMetadataControl, type RuntimeRenamePolicy } from './runtime-metadata-control'
import type { PhiTool, PhiToolImage, PhiToolApproval } from '../types'
import { executionRoster, type RpcExecutionTool } from '../phi-extension/lib/rpc-execution-protocol'
import type { RpcRuntimeConfig } from '../phi-extension/lib/rpc-runtime-config'
import { RpcConnection } from './connection'
import { RpcExecutionAuthority } from './execution-authority'
import { RpcApprovalBridge, type RpcApprovalBridgeOptions } from './approval-bridge'
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
import { publishRemoteSessionManifest } from './session-storage/remote-manifest'
import type { RemoteSessionStoragePreparation } from './session-storage/types'
import type { RpcSessionCreateParams } from './rpc-session-backend'
import type { RpcConnectionOptions, RpcPromptOptions, RpcPromptResult, RpcFrame } from './types'
import { createRpcRuntimeHostPolicy } from './runtime-host-policy'
import type { RpcHostToolRun } from './host-tool-bridge'
import type { SafeModelDescriptor } from '../model-gateway-types'

export interface RemoteRuntimeSnapshot extends Omit<RemoteSessionRecoveryResult, 'modelPolicy'> {
  readonly modelPolicy: RemoteSessionRecoveryResult['modelPolicy'] | 'maintained'
  readonly sessionName?: string
}
export interface RemoteRuntimeTurnResult {
  readonly result: RpcPromptResult
  readonly snapshot: RemoteRuntimeSnapshot
  /** Phi run state includes explicit policy denial even when SDK completes its error-result turn. */
  readonly outcome: 'completed' | 'failed' | 'aborted'
}
export interface RemoteSessionRuntimeOptions {
  readonly transport: Omit<ModelProxyRpcTransportOptions, 'prepareRuntime'>
  readonly params: RpcSessionCreateParams
  readonly action: RemoteRecoveryAction
  readonly sessionName?: string
  /** Genuine curated PhiTool instances supplied by the trusted facade. */
  readonly tools: readonly PhiTool[]
  readonly hostApprovalFor?: (
    toolName: string,
    input: Readonly<Record<string, unknown>>
  ) => PhiToolApproval | undefined
  readonly nativeTools?: readonly (
    'read' | 'write' | 'edit' | 'bash' | 'powershell' | 'glob' | 'grep'
  )[]
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
  private deniedRun?: string
  private readonly detach: Array<() => void> = []
  private readonly metadata = createRuntimeMetadataControl({
    signal: () => AbortSignal.any([this.lifetime.signal, this.connection.bindControl().signal]),
    claim: () => {
      if (!this.isReady || this.pending || this.authority?.currentRun())
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
  rename(name: string, policy?: RuntimeRenamePolicy): Promise<RemoteRuntimeSnapshot> {
    return this.metadata.rename(name, policy)
  }
  private constructor(private readonly options: RemoteSessionRuntimeOptions) {
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
  currentSnapshot(): RemoteRuntimeSnapshot {
    if (!this.snapshot || !this.isReady) throw new Error('Remote runtime is not ready')
    return this.snapshot
  }
  private active = (): void => {
    this.lifetime.signal.throwIfAborted()
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
      ...(options.nativeTools ?? (['read', 'write', 'edit', 'bash'] as const))
    ])
    const tools = Object.freeze([...registered.values()].map(({ tool }) => tool))
    const roster: readonly RpcExecutionTool[] = executionRoster([
      ...nativeTools.map((name) => ({
        name,
        site: 'native' as const
      })),
      ...[...registered.values()].map(({ definition }) => ({
        name: definition.name,
        site: 'host' as const,
        parameters: definition.parameters
      }))
    ]).tools
    if (!options.transport.preparePersistentStorage)
      throw new Error('Remote runtime requires registered persistent storage')
    this.transport = await prepareModelProxyRpcSessionTransport(
      {
        ...options.transport,
        prepareRuntime: async (context) => {
          this.lifetime.signal.throwIfAborted()
          if (!context.storage) throw new Error('Remote runtime requires persistent launch storage')
          this.storage = context.storage
          this.modelDescriptors = context.modelDescriptors
          const executionCapability = randomBytes(32).toString('hex'),
            resultCapability = randomBytes(32).toString('hex'),
            leaseId = randomBytes(32).toString('hex')
          this.delivery = await RpcHostResultDelivery.create({
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
            signal: context.signal,
            uploadOptions: options.transport.runtime.uploadOptions
          })
          this.config = Object.freeze({
            schema: 1,
            nonce: context.bootstrap.nonce,
            phiSessionId: context.params.sessionId,
            projectId: context.bootstrap.projectId,
            projectRoot: context.params.cwd,
            generation: context.generation,
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
          await publishRpcRuntimeConfig({
            context,
            host: options.transport.runtime.runtimeHost,
            config: this.config,
            uploadOptions: options.transport.runtime.uploadOptions
          })
          return { nativeTools }
        }
      },
      this.lifetime.signal
    )
    const cleanup = await this.transport.prepare(this.params, this.lifetime.signal)
    if (typeof cleanup === 'function') this.preparedCleanup = cleanup
    if (this.lifetime.signal.aborted) await this.preparedCleanup?.()
    this.lifetime.signal.throwIfAborted()
    await this.connection.start()
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
        generation: config.generation,
        projectRoot: config.projectRoot,
        directory: config.directory,
        journals: config.journals,
        blobs: config.blobs
      },
      assertActive: this.active
    })
    const result = await recoverRemoteSession({
      action: options.action,
      storage,
      connection: this.connection,
      control,
      signal: this.lifetime.signal,
      availableModels: options.transport.models,
      preflight: (reference) => preflightRemoteJournal(storage, reference),
      verifySavedState: (reference, signal) => this.verifier!.verifySavedState(reference, signal),
      selectModel: async (_reference, selection, signal) => {
        await this.transport.selectModel(
          { connection: this.connection, params: this.params, signal },
          { ...this.params.model!, ...selection.model }
        )
        if (selection.policy === 'fresh' && this.params.thinkingLevel)
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
          await attestRpcRuntime(this.connection, config, identity.ompSessionId, signal)
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
            signal
          })
        }
        return this.verifier!.verifyAttachment(identity, signal)
      },
      publish: async (reference, _checkpoint, signal) => {
        await publishRemoteSessionManifest(storage, reference, signal)
      },
      interrupt: (error) => this.close(error)
    })
    this.active()
    if (options.sessionName !== undefined) {
      await this.metadata.reconcileInitialName(options.sessionName, result)
      this.snapshot = result
      await this.checkpointUnderGate(options.sessionName)
      return
    }
    await withRemoteSignal(
      Promise.resolve().then(() => {
        this.active()
        return options.adopt(result, this.lifetime.signal)
      }),
      this.lifetime.signal
    )
    this.active()
    const final = await this.verifyCurrent(result)
    if (
      final.leafId !== result.checkpoint.leafId ||
      final.messageCount !== result.checkpoint.messageCount
    )
      throw new Error('Remote initialization checkpoint changed during adoption')
    this.verifier.commitAttachment()
    this.snapshot = result
  }
  private async verifyCurrent(snapshot: RemoteRuntimeSnapshot): Promise<RemoteHistoryCheckpoint> {
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
      messageCount: state.messageCount
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
    this.deniedRun = undefined
    const runSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
    const operation = Promise.resolve().then(async () => {
      await this.authority!.beginRun(runId, runSignal)
      const result = await this.authority!.prompt(text, options)
      this.gate = true
      const snapshot = await this.checkpoint()
      this.active()
      this.ready = true
      this.gate = false
      return {
        result,
        snapshot,
        outcome:
          result.status === 'aborted'
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
      if (this.pending === operation) this.pending = undefined
      if (this.promptController === controller) this.promptController = undefined
    }
  }
  private checkpoint(): Promise<RemoteRuntimeSnapshot> {
    return this.withCheckpoint(() => this.checkpointUnderGate())
  }
  private async checkpointUnderGate(sessionName?: string): Promise<RemoteRuntimeSnapshot> {
    this.active()
    const old = sessionName === undefined ? this.snapshot! : { ...this.snapshot!, sessionName }
    const checkpoint = await this.verifyCurrent(old)
    const before = await preflightRemoteJournal(this.storage!, old.reference)
    const messages = await readRemoteHistory({
      connection: this.connection,
      control: this.connection.bindControl(),
      checkpoint,
      signal: this.lifetime.signal,
      readCheckpoint: () => this.verifyCurrent(old)
    })
    const after = await preflightRemoteJournal(this.storage!, old.reference)
    if (before.fileIdentity !== after.fileIdentity || before.fingerprint !== after.fingerprint)
      throw new Error('Remote journal changed during checkpoint')
    const snapshot = Object.freeze({
      ...old,
      checkpoint,
      messages,
      modelPolicy: 'maintained' as const
    })
    await publishRemoteSessionManifest(this.storage!, old.reference, this.lifetime.signal)
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
    this.promptController?.abort(new Error('Phi run stopped'))
    await this.authority?.cancelRun()
    await this.pending
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
      for (const detach of this.detach.splice(0)) detach()
      this.approvals?.dispose()
      this.host?.dispose()
      await Promise.allSettled([
        this.delivery?.dispose(),
        this.authority?.dispose(),
        this.connection.close(),
        Promise.resolve().then(() => this.preparedCleanup?.())
      ])
    })
    this.lifetime.abort(reason)
    return this.closing
  }
}
