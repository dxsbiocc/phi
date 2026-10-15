import type { SessionRun } from '../../../session/session-runner-registry'
import { setTimeout as yieldForSettlement } from 'node:timers/promises'
import {
  CHILD_ATTEST_COMMAND,
  CHILD_ATTEST_DESCRIPTION,
  verifyRpcChildAttestation,
  type RpcChildRuntimeConfig
} from '../../phi-extension/lib/rpc-child-config'
import {
  validateRpcChildRoot,
  type RpcChildRootScope,
  type RpcChildCall
} from '../../phi-extension/lib/rpc-child-protocol'
import type { RpcConnection } from '../connection'
import type { RpcExecutionAuthority } from '../execution-authority'
import { withRemoteSignal } from '../history-pager'
import type { RpcApprovalEvent } from '../approval-bridge'
import type { RpcFrame } from '../types'
import { verifyRpcTaskSettlement } from '../../phi-extension/lib/rpc-task-settlement-protocol'
import { parseRpcTaskLaunchReceipt } from '../../phi-extension/lib/rpc-task-launch-protocol'
import { RpcChildAuthority } from './child-authority'
import type { RpcChildApprovalOptions } from './child-approval-bridge'
import { RpcChildHostUriBridge } from './host-uri-bridge'
import { ProductionChildLedger } from './production-child-ledger'
import {
  assertPreparedProductionChildConfig,
  type PreparedProductionChildConfig
} from './production-child-config'
import {
  RpcChildRunControls,
  type RpcChildWaitOptions,
  type RpcChildWaitResult
} from './child-run-controls'
import type { RpcChildRunSnapshot } from './types'
import type { RpcChildRun } from './run-registry'
import type { HostResultPayload } from '../../phi-extension/lib/rpc-host-result-protocol'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const composedGenerations = new WeakSet<AbortSignal>()
export type ProductionChildRootAttachment = Pick<
  RpcChildRootScope,
  'rootOmpSessionId' | 'rootSessionFile'
>

/** Discovered local command + independent HMAC + actual get_state identity, without invoking a model. */
export async function attestProductionChildRuntime(
  connection: RpcConnection,
  config: RpcChildRuntimeConfig,
  root: ProductionChildRootAttachment,
  signal: AbortSignal
): Promise<Readonly<RpcChildRootScope>> {
  const channel = connection.bindControl()
  const joined = AbortSignal.any([signal, channel.signal, AbortSignal.timeout(10000)])
  const stateMatches = async (): Promise<void> => {
    const state = await withRemoteSignal(connection.request<unknown>({ type: 'get_state' }), joined)
    if (
      !record(state) ||
      state.sessionId !== root.rootOmpSessionId ||
      state.sessionFile !== root.rootSessionFile
    )
      throw new Error('Child runtime differs from the actual attached root session')
  }
  if (channel.generation !== config.generation)
    throw new Error('Child runtime attestation generation differs')
  await stateMatches()
  const list = await withRemoteSignal(
    connection.request<unknown>({ type: 'get_available_commands' }),
    joined
  )
  const matches =
    record(list) && Array.isArray(list.commands)
      ? list.commands.filter((command) => record(command) && command.name === CHILD_ATTEST_COMMAND)
      : []
  if (
    matches.length !== 1 ||
    !record(matches[0]) ||
    matches[0].source !== 'extension' ||
    matches[0].description !== CHILD_ATTEST_DESCRIPTION
  )
    throw new Error('Child runtime attestation command is unavailable')
  let resolve!: (identity: Readonly<RpcChildRootScope>) => void, reject!: (error: Error) => void
  const proof = new Promise<Readonly<RpcChildRootScope>>((yes, no) => {
    resolve = yes
    reject = no
  })
  void proof.catch(() => undefined)
  const detach = channel.onFrame((frame) => {
    if (frame.type === 'agent_start') reject(new Error('Child runtime attestation invoked a model'))
    if (
      frame.type !== 'extension_ui_request' ||
      frame.method !== 'notify' ||
      typeof frame.message !== 'string'
    )
      return
    let value: unknown
    try {
      value = JSON.parse(frame.message)
    } catch {
      return
    }
    if (!record(value) || value.type !== 'phi_rpc_child_attestation') return
    let identity: Readonly<RpcChildRootScope>
    try {
      identity = validateRpcChildRoot(value.identity)
    } catch {
      reject(new Error('Child runtime attestation has an invalid root identity'))
      return
    }
    if (
      frame.notifyType !== 'info' ||
      Buffer.byteLength(frame.message) > 16384 ||
      identity.rootOmpSessionId !== root.rootOmpSessionId ||
      identity.rootSessionFile !== root.rootSessionFile ||
      !verifyRpcChildAttestation(value, config, identity)
    )
      reject(new Error('Child runtime attestation differs from its trusted publication'))
    else resolve(identity)
  })
  try {
    const [result, identity] = await withRemoteSignal(
      Promise.all([connection.prompt(`/${CHILD_ATTEST_COMMAND} ${config.nonce}`), proof]),
      joined
    )
    if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled)
      throw new Error('Child runtime attestation did not settle locally')
    await stateMatches()
    return identity
  } finally {
    detach()
  }
}

export interface ProductionChildRuntimeOptions {
  readonly connection: RpcConnection
  readonly execution: RpcExecutionAuthority
  readonly prepared: PreparedProductionChildConfig
  /** Previously verified attached root journal and SDK identity. */
  readonly root: ProductionChildRootAttachment
  readonly currentParentRun: () => SessionRun | undefined
  readonly approval: RpcChildApprovalOptions
  readonly onDenied: (parent: SessionRun, event: RpcApprovalEvent) => void
  readonly onError: (error: Error) => void
  readonly signal: AbortSignal
  readonly onChildChange?: (snapshot: Readonly<RpcChildRunSnapshot>, parent: SessionRun) => void
  readonly onChildFinished?: (
    snapshot: Readonly<RpcChildRunSnapshot>,
    parent: SessionRun
  ) => void | Promise<void>
  readonly executeHost?: (
    run: RpcChildRun,
    call: RpcChildCall,
    requestId: string,
    signal: AbortSignal
  ) => Promise<HostResultPayload>
  readonly hostResultConsumed?: (
    run: RpcChildRun,
    call: RpcChildCall,
    invocationId: string
  ) => void | Promise<void>
  readonly drainHost?: (childRunId?: string) => Promise<void>
}

/** Generation composition API. Normal main turn completion never disposes this authority. */
export class ProductionChildRuntime {
  private readonly ledger: ProductionChildLedger
  private readonly authority: RpcChildAuthority
  private readonly uri: RpcChildHostUriBridge
  private readonly controls: RpcChildRunControls
  private readonly finished = new Set<string>()
  private readonly pendingCompletion = new Set<string>()
  private readonly completionDeliveries = new Map<string, Promise<void>>()
  private readonly detach: Array<() => void> = []
  private readonly childParents = new Map<string, SessionRun>()
  private readonly stops = new Map<string, Promise<void>>()
  private readonly conflictFaults = new Set<string>()
  private failureReported = false
  private disposed = false

  private constructor(
    private readonly options: ProductionChildRuntimeOptions,
    identity: Readonly<RpcChildRootScope>
  ) {
    this.options = options = Object.freeze({
      ...options,
      root: Object.freeze({ ...options.root }),
      approval: Object.freeze({ ...options.approval })
    })
    const { config } = options.prepared
    const parallel = config.policy.allowParallel === true
    const background = config.policy.allowBackground === true
    const channel = options.connection.bindControl()
    const execution = options.execution.sessionIdentity()
    if (
      execution.phiSessionId !== identity.phiSessionId ||
      execution.projectId !== identity.projectId ||
      execution.cwd !== identity.cwd ||
      execution.generation !== identity.generation ||
      execution.ompSessionId !== identity.rootOmpSessionId ||
      execution.nonce !== config.nonce ||
      channel.generation !== identity.generation
    )
      throw new Error('Child runtime differs from its actual execution generation')
    options.signal.throwIfAborted()
    channel.signal.throwIfAborted()
    this.ledger = new ProductionChildLedger({
      phiSessionId: config.phiSessionId,
      generation: config.generation,
      allowBackground: background,
      maxChildrenPerTask: parallel ? 32 : 1,
      requireDispatchSeal: parallel || background,
      currentParentRun: options.currentParentRun,
      isNativeTerminal: (nativeId, parentRunId) =>
        !this.authority.registry.nativeChildren(parentRunId).includes(nativeId),
      onStop: (parent) => {
        void this.stopParent(parent.runId).catch((error: unknown) => this.fail(error))
      }
    })
    this.authority = new RpcChildAuthority({
      identity,
      manifestBinding: config.manifestBinding,
      profiles: config.profiles,
      capability: config.capability,
      signal: channel.signal,
      executeHost: options.executeHost,
      hostResultConsumed: options.hostResultConsumed,
      drainHost: options.drainHost,
      captureParent: (started) => this.ledger.captureParent(started),
      approval: {
        ...options.approval,
        onEvent: (event) => {
          const parent = this.captureApprovalParent(event)
          if (!parent) {
            this.fail(new Error('Child approval lacks its registered Phi parent'))
            return
          }
          if (event.type === 'approval_denied') options.onDenied(parent, event)
          return options.approval.onEvent?.(event)
        }
      },
      cancelNativeChild: async (nativeAgentId) => {
        const response = await options.connection.request<unknown>({
          type: 'cancel_subagent',
          subagentId: nativeAgentId
        })
        return record(response) && response.cancelled === true
      }
    })
    this.controls = new RpcChildRunControls({
      connection: options.connection,
      authority: this.authority,
      config,
      signal: options.signal,
      onUnconfirmed: (error) => this.fail(error)
    })
    this.detach.push(
      this.authority.registry.onChange((snapshot) => {
        const parent = this.ledger.parent(snapshot.parentRunId)
        if (!parent) {
          this.fail(new Error('Child lifecycle lacks its registered Phi parent'))
          return
        }
        this.childParents.set(snapshot.id, parent)
        try {
          options.onChildChange?.(snapshot, parent)
        } catch (error) {
          this.fail(error)
          return
        }
        if (!snapshot.background || snapshot.completedAt === undefined) return
        const receipt = JSON.stringify([snapshot.phiSessionId, snapshot.generation, snapshot.id])
        if (this.finished.has(receipt)) return
        this.finished.add(receipt)
        this.pendingCompletion.add(receipt)
        const delivery = Promise.resolve()
          .then(() => {
            if (this.disposed || options.signal.aborted) return
            return this.authority.drainHostExecutions(snapshot.id).then(() => {
              if (this.disposed || options.signal.aborted) return
              return options.onChildFinished?.(snapshot, parent)
            })
          })
          .catch((error: unknown) => {
            this.fail(error)
            throw error
          })
          .finally(() => this.pendingCompletion.delete(receipt))
        this.completionDeliveries.set(snapshot.id, delivery)
        void delivery.catch(() => undefined)
      })
    )
    this.detach.push(
      options.execution.onTaskOrigin((event) => this.ledger.remember(event)),
      channel.onFrame((frame) => {
        this.consumeSettlement(frame, identity)
        this.authority.observe(frame)
        this.ledger.observeTaskEnd(frame)
        if (
          frame.type === 'subagent_lifecycle' &&
          record(frame.payload) &&
          frame.payload.status === 'started' &&
          typeof frame.payload.id === 'string'
        ) {
          const parent = this.ledger.parentForNative(frame.payload.id)
          if (parent && this.ledger.hasNoSpawnConflict(parent.runId))
            this.faultAfterConflictCancellation(parent.runId)
        }
      })
    )
    this.uri = new RpcChildHostUriBridge({ channel, authority: this.authority })
    const dispose = (): void => this.dispose()
    for (const signal of [options.signal, channel.signal]) {
      signal.addEventListener('abort', dispose, { once: true })
      this.detach.push(() => signal.removeEventListener('abort', dispose))
      if (signal.aborted) this.dispose()
    }
  }

  static async create(options: ProductionChildRuntimeOptions): Promise<ProductionChildRuntime> {
    assertPreparedProductionChildConfig(options.prepared)
    if (!options.execution.allowsNativeTask())
      throw new Error('Execution authority has no native task opt-in')
    const channel = options.connection.bindControl()
    if (composedGenerations.has(channel.signal))
      throw new Error('Child generation was already composed')
    composedGenerations.add(channel.signal)
    const { config } = options.prepared
    const identity = await attestProductionChildRuntime(
      options.connection,
      config,
      options.root,
      options.signal
    )
    const runtime = new ProductionChildRuntime(options, identity)
    try {
      await withRemoteSignal(
        options.connection.request({ type: 'set_subagent_subscription', level: 'events' }),
        options.signal
      )
      await withRemoteSignal(
        options.connection.request({
          type: 'set_host_uri_schemes',
          schemes: [{ scheme: 'phi-child', writable: true }]
        }),
        options.signal
      )
      options.signal.throwIfAborted()
      channel.signal.throwIfAborted()
      return runtime
    } catch (error) {
      runtime.dispose()
      throw error
    }
  }

  /** Official cancellation ACK and observed aborted lifecycle must precede parent/channel teardown. */
  stopParent(parentRunId: string): Promise<void> {
    if (this.disposed || this.options.signal.aborted)
      return Promise.reject(new Error('Child runtime cancellation is unavailable'))
    const channel = this.options.connection.bindControl()
    if (channel.signal.aborted)
      return Promise.reject(new Error('Child runtime cancellation is unavailable'))
    const known = this.stops.get(parentRunId)
    if (known) return known
    this.authority.registry.cancelParent(parentRunId)
    const signal = AbortSignal.any([
      channel.signal,
      this.options.signal,
      AbortSignal.timeout(10000)
    ])
    const stopping = Promise.resolve()
      .then(async () => {
        await this.ledger.waitForStarts(parentRunId, signal)
        await withRemoteSignal(this.authority.cancelParent(parentRunId), signal)
        this.assertParentSettled(parentRunId)
      })
      .finally(() => {
        if (this.stops.get(parentRunId) === stopping) this.stops.delete(parentRunId)
      })
    this.stops.set(parentRunId, stopping)
    return stopping
  }

  /** Tentative/unregistered native starts remain outstanding until a real matching terminal event. */
  assertParentSettled(parentRunId: string): void {
    if (this.disposed || this.options.connection.bindControl().signal.aborted)
      throw new Error('Child runtime settlement authority is unavailable')
    this.ledger.assertNoPendingStarts(parentRunId)
    if (this.authority.registry.nativeChildren(parentRunId).length)
      throw new Error('Native children have not reached an observed terminal lifecycle')
  }

  parentForChild(childRunId: string): SessionRun | undefined {
    const cached = this.childParents.get(childRunId)
    if (cached) return cached
    if (this.disposed) return undefined
    const child = this.authority.registry.getRecord(childRunId)
    const parent = child && this.ledger.parent(child.parentRunId)
    if (parent) this.childParents.set(childRunId, parent)
    return parent
  }
  listRuns(): readonly Readonly<RpcChildRunSnapshot>[] {
    return this.controls.listRuns()
  }
  status(childRunId: string): Readonly<RpcChildRunSnapshot> {
    return this.controls.status(childRunId)
  }
  wait(options: RpcChildWaitOptions = {}): Promise<RpcChildWaitResult> {
    return this.controls.wait(options)
  }
  steer(childRunId: string, message: string, signal?: AbortSignal): Promise<void> {
    return this.controls.steer(childRunId, message, signal)
  }
  stopChild(childRunId: string, signal?: AbortSignal): Promise<Readonly<RpcChildRunSnapshot>> {
    return this.controls.stop(childRunId, signal)
  }
  /** A terminal fact is reportable after physical host drain and durable parent delivery. */
  awaitChildCompletionDelivery(childRunId: string): Promise<void> {
    const child = this.controls.status(childRunId)
    return this.completionDeliveries.get(child.id) ?? Promise.resolve()
  }
  hasActiveChildren(): boolean {
    return (
      this.pendingCompletion.size > 0 ||
      this.ledger.hasPendingStarts() ||
      this.listRuns().some((run) => run.completedAt === undefined)
    )
  }
  childRunForHost(id: string): RpcChildRun | undefined {
    const record =
      this.authority.registry.getRecord(id) ?? this.authority.registry.recordForNative(id)
    const run = record && this.authority.registry.getRun(record.id)
    return run && this.authority.registry.current(run.scope) === run ? run : undefined
  }
  drainHost(childRunId?: string): Promise<void> {
    return this.authority.drainHostExecutions(childRunId)
  }
  /** Background children may live on, but the actual parent and every admitted launch must settle. */
  async awaitParentPromptSettled(parentRunId: string, signal: AbortSignal): Promise<void> {
    const channel = this.options.connection.bindControl()
    const joined = AbortSignal.any([
      signal,
      channel.signal,
      this.options.signal,
      AbortSignal.timeout(10000)
    ])
    await this.ledger.waitForStarts(parentRunId, joined)
    for (;;) {
      joined.throwIfAborted()
      if (this.disposed) throw new Error('Child parent settlement is unavailable')
      this.ledger.assertNoPendingStarts(parentRunId)
      const children = this.ledger
        .nativeIdsForParent(parentRunId)
        .map((id) => this.authority.registry.recordForNative(id))
      if (
        children.some((child) => child?.status === 'interrupted' && child.completedAt === undefined)
      )
        throw new Error('Child admission was not confirmed')
      const admitted = children.every(
        (child) =>
          child &&
          (child.completedAt !== undefined ||
            (child.background && child.verified && child.status === 'running'))
      )
      if (admitted) {
        const state = await withRemoteSignal(
          this.options.connection.request<unknown>({ type: 'get_state' }),
          joined
        )
        if (
          !record(state) ||
          state.sessionId !== this.authority.registry.identity.rootOmpSessionId ||
          state.sessionFile !== this.authority.registry.identity.rootSessionFile
        )
          throw new Error('Child parent session was replaced')
        if (
          state.isStreaming === false &&
          state.isCompacting === false &&
          state.isSettled === true &&
          state.queuedMessageCount === 0 &&
          state.hasPendingAsyncWork === false
        ) {
          await Promise.all(
            children
              .filter((child) => child?.completedAt !== undefined)
              .map((child) => this.authority.drainHostExecutions(child!.id))
          )
          return
        }
      }
      await yieldForSettlement(10, undefined, { signal: joined })
    }
  }

  /** A no-spawn receipt leaves a same-generation outer-ID tombstone, so the controller must rotate. */
  needsGenerationRetirement(parentRunId: string): boolean {
    return this.ledger.needsGenerationRetirement(parentRunId)
  }

  private consumeSettlement(frame: RpcFrame, identity: Readonly<RpcChildRootScope>): void {
    if (
      this.disposed ||
      frame.type !== 'extension_ui_request' ||
      frame.method !== 'notify' ||
      frame.notifyType !== 'info' ||
      typeof frame.message !== 'string'
    )
      return
    const launch = parseRpcTaskLaunchReceipt(frame.message, this.options.prepared.config, identity)
    if (launch) {
      try {
        this.ledger.acceptTaskLaunch(launch)
      } catch (error) {
        this.fail(error)
        return
      }
      if (this.ledger.hasNoSpawnConflict(launch.parentRunId))
        this.faultAfterConflictCancellation(launch.parentRunId)
      return
    }
    const proof = verifyRpcTaskSettlement(frame.message, this.options.prepared.config, identity)
    if (!proof) return
    const parent = this.ledger.consumeNoSpawn(proof)
    if (!parent) return
    this.authority.registry.cancelParent(parent.runId)
    if (this.options.execution.currentRun()?.id === parent.runId)
      this.options.execution.revokeRun(parent.runId)
    if (this.ledger.hasNoSpawnConflict(parent.runId))
      this.faultAfterConflictCancellation(parent.runId)
  }

  private faultAfterConflictCancellation(parentRunId: string): void {
    if (this.conflictFaults.has(parentRunId)) return
    this.conflictFaults.add(parentRunId)
    // Fault cleanup uses the sole foundation cancel tracker even if a sibling origin is still unproved.
    void this.authority.cancelParent(parentRunId).then(
      () => this.fail(new Error('Authenticated no-spawn proof conflicts with a real native child')),
      () => this.fail(new Error('No-spawn conflict native cancellation was not confirmed'))
    )
  }

  /** Local revocation only; disconnect cannot establish that the remote process stopped. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Emit conservative interruption while the original parent ledger is still available.
    this.uri.dispose()
    for (const detach of this.detach.splice(0)) detach()
    this.ledger.dispose()
    // Submitted writer callbacks still need the originating parent for their sole terminal event.
  }

  private captureApprovalParent(event: RpcApprovalEvent): SessionRun | undefined {
    if (
      event.sessionId !== this.options.prepared.config.phiSessionId ||
      event.request.agentRunId !== event.runId
    )
      return undefined
    return this.parentForChild(event.runId)
  }

  private fail(error: unknown): void {
    if (this.failureReported) return
    this.failureReported = true
    this.dispose()
    try {
      this.options.onError(error instanceof Error ? error : new Error('Child runtime failed'))
    } catch {
      this.dispose()
    }
  }
}
