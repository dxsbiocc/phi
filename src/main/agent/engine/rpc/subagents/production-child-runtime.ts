import type { SessionRun } from '../../../session/session-runner-registry'
import { setTimeout as yieldForSettlement } from 'node:timers/promises'
import {
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
import { cancelObservedHostStart, observedHostStartNativeIds } from './observed-host-cancel'
import { CodedError } from '../../../../../shared/errorCodes'
import {
  attestProductionChildRuntime,
  type ProductionChildRootAttachment
} from './child-runtime-attestation'
export { attestProductionChildRuntime } from './child-runtime-attestation'
export type { ProductionChildRootAttachment } from './child-runtime-attestation'
import {
  createRpcChildHostStartRequest,
  parseRpcChildHostCancelReceipt,
  parseRpcChildHostStartReceipt,
  RPC_CHILD_HOST_CANCEL_COMMAND,
  RPC_CHILD_HOST_START_COMMAND,
  RPC_CHILD_HOST_START_DESCRIPTION,
  type RpcChildHostStartReceipt
} from '../../phi-extension/lib/rpc-child-host-start'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const composedGenerations = new WeakSet<AbortSignal>()
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
    parent: SessionRun,
    task?: string
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
  private readonly hostParents = new Map<
    string,
    { parent: SessionRun; receipt: RpcChildHostStartReceipt; task: string }
  >()
  private readonly pendingHostStarts = new Map<
    string,
    {
      readonly parent: SessionRun
      readonly request: ReturnType<typeof createRpcChildHostStartRequest>
      readonly frames: RpcFrame[]
      proof?: RpcChildHostStartReceipt
      failed?: boolean
      readonly resolve: (receipt: RpcChildHostStartReceipt) => void
      readonly reject: (error: Error) => void
    }
  >()
  private readonly stops = new Map<string, Promise<void>>()
  private readonly stopCancellations = new Map<
    string,
    { controller: AbortController; children: Map<string, Promise<void>> }
  >()
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
    this.authority = this.createAuthority(identity, channel.signal)
    this.controls = new RpcChildRunControls({
      connection: options.connection,
      authority: this.authority,
      config,
      signal: options.signal,
      onUnconfirmed: (error) => this.fail(error)
    })
    this.attachRuntimeListeners(options, identity, channel)
    this.uri = new RpcChildHostUriBridge({ channel, authority: this.authority })
    this.attachAbortListeners(options.signal, channel.signal)
  }

  private createAuthority(
    identity: Readonly<RpcChildRootScope>,
    channelSignal: AbortSignal
  ): RpcChildAuthority {
    const { options } = this
    const { config } = options.prepared
    return new RpcChildAuthority({
      identity,
      manifestBinding: config.manifestBinding,
      profiles: config.profiles,
      capability: config.capability,
      signal: channelSignal,
      executeHost: options.executeHost,
      hostResultConsumed: options.hostResultConsumed,
      drainHost: options.drainHost,
      captureParent: (started) => {
        const host = this.hostParents.get(started.parentToolCallId)
        if (host)
          return host.receipt.nativeId === started.id &&
            host.receipt.agent === started.agent &&
            host.receipt.childSessionFile === started.sessionFile &&
            started.detached
            ? { runId: host.parent.runId }
            : undefined
        return this.ledger.captureParent(started)
      },
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
        if (!record(response)) return false
        if (response.cancelled === true) return true
        if (response.cancelled !== false) return false
        const child = this.authority.registry.recordForNative(nativeAgentId)
        if (!child?.verified || child.completedAt !== undefined) return false
        return this.controls.cancelQueued(nativeAgentId)
      }
    })
  }

  private attachRuntimeListeners(
    options: ProductionChildRuntimeOptions,
    identity: Readonly<RpcChildRootScope>,
    channel: ReturnType<RpcConnection['bindControl']>
  ): void {
    this.detach.push(
      this.authority.registry.onChange((snapshot) => this.onChildChange(snapshot, options))
    )
    this.detach.push(
      options.execution.onTaskOrigin((event) => this.ledger.remember(event)),
      channel.onFrame((frame) => this.onFrame(frame, identity))
    )
  }

  private attachAbortListeners(...signals: AbortSignal[]): void {
    const dispose = (): void => this.dispose()
    for (const signal of signals) {
      signal.addEventListener('abort', dispose, { once: true })
      this.detach.push(() => signal.removeEventListener('abort', dispose))
      if (signal.aborted) this.dispose()
    }
  }

  private onChildChange(
    snapshot: Readonly<RpcChildRunSnapshot>,
    options: ProductionChildRuntimeOptions
  ): void {
    const parent =
      this.ledger.parent(snapshot.parentRunId) ??
      this.hostParents.get(snapshot.parentToolCallId)?.parent
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
          return options.onChildFinished?.(
            snapshot,
            parent,
            this.hostParents.get(snapshot.parentToolCallId)?.task
          )
        })
      })
      .catch((error: unknown) => {
        this.fail(error)
        throw error
      })
      .finally(() => this.pendingCompletion.delete(receipt))
    this.completionDeliveries.set(snapshot.id, delivery)
    void delivery.catch(() => undefined)
  }

  private onFrame(frame: RpcFrame, identity: Readonly<RpcChildRootScope>): void {
    if (this.consumeHostStart(frame)) return
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
      if (parent) this.cancelStoppingChild(parent.runId, frame.payload.id)
      if (parent && this.ledger.hasNoSpawnConflict(parent.runId))
        this.faultAfterConflictCancellation(parent.runId)
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
    const tracker = {
      controller: new AbortController(),
      children: new Map<string, Promise<void>>()
    }
    const signal = AbortSignal.any([
      channel.signal,
      this.options.signal,
      tracker.controller.signal,
      AbortSignal.timeout(10000)
    ])
    const stopping = Promise.resolve()
      .then(async () => {
        // Foreground TaskTool seals only after its children finish. Start their
        // genuine cancellation now, while the exact dispatch seal is pending.
        for (const id of this.authority.registry.nativeChildren(parentRunId))
          this.cancelStoppingChild(parentRunId, id)
        await this.ledger.waitForStarts(parentRunId, signal)
        await withRemoteSignal(Promise.all(tracker.children.values()), signal)
        await withRemoteSignal(this.authority.cancelParent(parentRunId), signal)
        this.assertParentSettled(parentRunId)
      })
      .finally(() => {
        tracker.controller.abort()
        if (this.stopCancellations.get(parentRunId) === tracker)
          this.stopCancellations.delete(parentRunId)
        this.authority.registry.drainParentModels(parentRunId)
        if (this.stops.get(parentRunId) === stopping) this.stops.delete(parentRunId)
      })
    this.stops.set(parentRunId, stopping)
    this.stopCancellations.set(parentRunId, tracker)
    // Publish stop ownership before synchronous permission observers can reenter.
    this.authority.registry.cancelParent(parentRunId)
    return stopping
  }

  private cancelStoppingChild(parentRunId: string, nativeId: string): void {
    const tracker = this.stopCancellations.get(parentRunId)
    if (!tracker || tracker.children.has(nativeId)) return
    const cancellation = this.authority.cancelChild(nativeId)
    tracker.children.set(nativeId, cancellation)
    // Keep the real failure (including a refused ACK) instead of masking it
    // with the later seal deadline, and immediately observe every rejection.
    void cancellation.catch((error: unknown) => tracker.controller.abort(error))
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
    const parent =
      child &&
      (this.ledger.parent(child.parentRunId) ??
        this.hostParents.get(child.parentToolCallId)?.parent)
    if (parent) this.childParents.set(childRunId, parent)
    return parent
  }
  listRuns(): readonly Readonly<RpcChildRunSnapshot>[] {
    return this.controls.listRuns()
  }
  /** Starts one compiled background agent without a live Main model turn. */
  async startHostChild(
    agent: string,
    task: string,
    requestId: string,
    expected: Pick<RpcChildRootScope, 'phiSessionId' | 'projectId' | 'cwd' | 'rootOmpSessionId'>
  ): Promise<{ runId: string }> {
    const nativeName = this.assertHostChildAvailable(agent, requestId, expected)
    const channel = this.options.connection.bindControl()
    if (this.disposed || this.options.signal.aborted || channel.signal.aborted)
      throw new Error('Remote plan child runtime is unavailable')
    await this.assertHostStartCommand(channel.signal)
    const { config } = this.options.prepared
    const request = createRpcChildHostStartRequest(
      config,
      this.authority.registry.identity,
      requestId,
      nativeName,
      task
    )
    const parent: SessionRun = {
      sessionId: config.phiSessionId,
      runId: request.id,
      signal: this.options.signal,
      startedAt: new Date().toISOString(),
      done: Promise.resolve(),
      status: 'running'
    }
    let resolve!: (receipt: RpcChildHostStartReceipt) => void
    let reject!: (error: Error) => void
    const receipt = new Promise<RpcChildHostStartReceipt>((yes, no) => {
      resolve = yes
      reject = no
    })
    void receipt.catch(() => undefined)
    if (this.pendingHostStarts.has(request.id) || this.hostParents.has(request.id))
      throw new Error('Remote plan child request was already admitted')
    this.pendingHostStarts.set(request.id, { parent, request, frames: [], resolve, reject })
    const joined = AbortSignal.any([
      this.options.signal,
      channel.signal,
      AbortSignal.timeout(15000)
    ])
    try {
      const result = await withRemoteSignal(
        this.options.connection.prompt(
          `/${RPC_CHILD_HOST_START_COMMAND} ${JSON.stringify(request)}`
        ),
        joined
      )
      if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled)
        throw new Error('Remote host child command invoked the Main model')
      // The control stream delivers all notify/lifecycle frames before prompt_result.
      // A settled command with no confirmed receipt cannot gain one later.
      const pending = this.pendingHostStarts.get(request.id)
      if (pending?.failed) await receipt
      if (pending)
        throw new Error('Remote host child command ended without a verified start receipt')
      const proof = await receipt
      return { runId: (await this.verifiedHostRun(proof, request.id, joined)).id }
    } catch (error) {
      throw await this.failHostStart(request, error)
    } finally {
      this.pendingHostStarts.delete(request.id)
    }
  }

  private assertHostChildAvailable(
    agent: string,
    requestId: string,
    expected: Pick<RpcChildRootScope, 'phiSessionId' | 'projectId' | 'cwd' | 'rootOmpSessionId'>
  ): string {
    const root = this.authority.registry.identity
    if (
      expected.phiSessionId !== root.phiSessionId ||
      expected.projectId !== root.projectId ||
      expected.cwd !== root.cwd ||
      expected.rootOmpSessionId !== root.rootOmpSessionId
    )
      throw new Error('Remote plan child owner differs from the attached root')
    const { config } = this.options.prepared
    const profile = config.profiles.find(
      (entry) => entry.definition.phiName === agent && !entry.definition.blocking
    )
    if (!profile || !config.policy.allowBackground)
      throw new Error('Remote plan child agent is unavailable')
    if (
      this.pendingHostStarts.has(requestId) ||
      this.hostParents.has(requestId) ||
      this.pendingHostStarts.size + this.hostParents.size >= 4096
    )
      throw new Error('Remote plan child request already belongs to this generation')
    return profile.definition.nativeName
  }

  private async assertHostStartCommand(channelSignal: AbortSignal): Promise<void> {
    const commands = await withRemoteSignal(
      this.options.connection.request<unknown>({ type: 'get_available_commands' }),
      AbortSignal.any([this.options.signal, channelSignal, AbortSignal.timeout(10000)])
    )
    const available =
      record(commands) && Array.isArray(commands.commands)
        ? commands.commands.filter(
            (command) =>
              record(command) &&
              command.name === RPC_CHILD_HOST_START_COMMAND &&
              command.description === RPC_CHILD_HOST_START_DESCRIPTION &&
              command.source === 'extension'
          )
        : []
    if (available.length !== 1) throw new Error('Remote plan child start command is unavailable')
  }

  private async verifiedHostRun(
    proof: RpcChildHostStartReceipt,
    requestId: string,
    joined: AbortSignal
  ): Promise<Readonly<RpcChildRunSnapshot>> {
    const registry = this.authority.registry
    let run = registry.recordForNative(proof.nativeId)
    if (run && !run.verified && run.completedAt === undefined) {
      let detach: (() => void) | undefined
      try {
        run = await withRemoteSignal(
          new Promise<Readonly<RpcChildRunSnapshot>>((resolve) => {
            detach = registry.onChange((snapshot) => {
              if (
                snapshot.nativeId !== proof.nativeId ||
                (!snapshot.verified && !snapshot.completedAt)
              )
                return
              resolve(snapshot)
            })
          }),
          joined
        )
      } finally {
        detach?.()
      }
    }
    if (!run || run.parentToolCallId !== requestId || !run.verified)
      throw new Error('Remote host child did not verify its exact native identity')
    return run
  }

  private async failHostStart(
    request: ReturnType<typeof createRpcChildHostStartRequest>,
    error: unknown
  ): Promise<unknown> {
    let outcome: 'quiescent' | 'unknown' = 'unknown'
    try {
      outcome = await this.reconcileHostStart(request)
    } catch {
      outcome = 'unknown'
    }
    const pending = this.pendingHostStarts.get(request.id)
    if (outcome === 'unknown' && pending)
      await cancelObservedHostStart(
        this.options.connection,
        this.options.signal,
        pending.request,
        pending.frames
      ).catch(() => undefined)
    const failure =
      outcome === 'unknown'
        ? new CodedError(
            'TIMEOUT_UNKNOWN',
            `Remote host child start ${request.id} is UNKNOWN; this generation cannot retry`
          )
        : error
    this.fail(failure)
    await this.options.connection.close().catch(() => undefined)
    return failure
  }

  private async reconcileHostStart(
    request: ReturnType<typeof createRpcChildHostStartRequest>
  ): Promise<'quiescent' | 'unknown'> {
    const channel = this.options.connection.bindControl()
    const joined = AbortSignal.any([
      this.options.signal,
      channel.signal,
      AbortSignal.timeout(10000)
    ])
    let resolve!: (state: 'quiescent' | 'unknown') => void
    let reject!: (error: Error) => void
    const receipt = new Promise<'quiescent' | 'unknown'>((yes, no) => {
      resolve = yes
      reject = no
    })
    void receipt.catch(() => undefined)
    const detach = channel.onFrame((frame) => {
      if (
        frame.type !== 'extension_ui_request' ||
        frame.method !== 'notify' ||
        frame.notifyType !== 'info' ||
        typeof frame.message !== 'string'
      )
        return
      let value: unknown
      try {
        value = JSON.parse(frame.message)
      } catch {
        return
      }
      if (!record(value) || value.type !== 'phi_rpc_child_host_cancel_receipt') return
      try {
        const proof = parseRpcChildHostCancelReceipt(
          frame.message,
          request,
          this.options.prepared.config
        )
        const observed = observedHostStartNativeIds(
          request,
          this.pendingHostStarts.get(request.id)?.frames ?? []
        )
        resolve(
          proof.state === 'quiescent' &&
            [...observed].some((nativeId) => !proof.nativeIds.includes(nativeId))
            ? 'unknown'
            : proof.state
        )
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Invalid host cancellation receipt'))
      }
    })
    try {
      const [result, state] = await withRemoteSignal(
        Promise.all([
          this.options.connection.prompt(
            `/${RPC_CHILD_HOST_CANCEL_COMMAND} ${JSON.stringify(request)}`
          ),
          receipt
        ]),
        joined
      )
      if (result.agentInvoked || result.status !== 'completed' || !result.sessionSettled)
        throw new Error('Remote host cancellation did not settle locally')
      return state
    } finally {
      detach()
    }
  }

  private consumeHostStart(frame: RpcFrame): boolean {
    if (this.consumePendingHostLifecycle(frame)) return true
    if (
      frame.type !== 'extension_ui_request' ||
      frame.method !== 'notify' ||
      frame.notifyType !== 'info' ||
      typeof frame.message !== 'string'
    )
      return false
    let value: unknown
    try {
      value = JSON.parse(frame.message)
    } catch {
      return false
    }
    if (!record(value) || value.type !== 'phi_rpc_child_host_start_receipt') return false
    const pending = typeof value.id === 'string' ? this.pendingHostStarts.get(value.id) : undefined
    if (!pending) return true
    try {
      pending.proof = parseRpcChildHostStartReceipt(
        frame.message,
        pending.request,
        this.options.prepared.config
      )
      this.confirmHostStart(pending)
    } catch (error) {
      pending.failed = true
      pending.reject(
        error instanceof Error ? error : new Error('Invalid remote host child receipt')
      )
    }
    return true
  }

  private consumePendingHostLifecycle(frame: RpcFrame): boolean {
    if (
      frame.type === 'subagent_lifecycle' &&
      record(frame.payload) &&
      typeof frame.payload.parentToolCallId === 'string'
    ) {
      const pending = this.pendingHostStarts.get(frame.payload.parentToolCallId)
      if (pending) {
        if (pending.failed) return true
        if (pending.frames.length >= 128) {
          pending.failed = true
          pending.reject(new Error('Remote host child lifecycle exceeded its pending bound'))
        } else {
          pending.frames.push(frame)
          this.confirmHostStart(pending)
        }
        return true
      }
    }
    return false
  }

  private confirmHostStart(pending: {
    readonly parent: SessionRun
    readonly request: ReturnType<typeof createRpcChildHostStartRequest>
    readonly frames: RpcFrame[]
    proof?: RpcChildHostStartReceipt
    failed?: boolean
    readonly resolve: (receipt: RpcChildHostStartReceipt) => void
    readonly reject: (error: Error) => void
  }): void {
    if (pending.failed) return
    const proof = pending.proof
    const started = pending.frames.find(
      (event) =>
        event.type === 'subagent_lifecycle' &&
        record(event.payload) &&
        event.payload.status === 'started'
    )
    if (!proof || !started || started.type !== 'subagent_lifecycle' || !record(started.payload))
      return
    if (
      started.payload.id !== proof.nativeId ||
      started.payload.sessionFile !== proof.childSessionFile ||
      started.payload.agent !== proof.agent ||
      started.payload.parentToolCallId !== proof.parentToolCallId ||
      started.payload.detached !== true
    ) {
      pending.failed = true
      pending.reject(new Error('Remote host child receipt differs from its observed native start'))
      return
    }
    this.hostParents.set(proof.parentToolCallId, {
      parent: pending.parent,
      receipt: proof,
      task: pending.request.task
    })
    this.pendingHostStarts.delete(proof.id)
    for (const event of pending.frames) this.authority.observe(event)
    pending.resolve(proof)
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
    for (const tracker of this.stopCancellations.values())
      tracker.controller.abort(new Error('Child runtime cancellation is unavailable'))
    this.stopCancellations.clear()
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
