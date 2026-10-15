import { timingSafeEqual } from 'node:crypto'
import {
  MAX_RPC_CHILD_CALLS,
  parseRpcChildRequest,
  sameRpcChildScope,
  type RpcChildReply,
  type RpcChildRequest,
  type RpcChildScope,
  type RpcChildCall
} from '../../phi-extension/lib/rpc-child-protocol'
import {
  isHostResultPlaceholder,
  validHostResultPayload,
  type HostResultPayload
} from '../../phi-extension/lib/rpc-host-result-protocol'
import { executionCapability } from '../../phi-extension/lib/rpc-execution-protocol'
import type { RpcFrame } from '../types'
import { withRemoteSignal } from '../history-pager'
import {
  RpcChildApprovalBridge,
  type RpcChildApprovalOptions,
  type RpcChildApprovalPermit
} from './child-approval-bridge'
import { RpcChildRunRegistry, type RpcChildRegistryOptions, type RpcChildRun } from './run-registry'

export interface RpcChildAuthorityOptions extends RpcChildRegistryOptions {
  readonly capability: string
  readonly approval: RpcChildApprovalOptions
  readonly cancelNativeChild: (nativeAgentId: string) => boolean | Promise<boolean>
  readonly cancellationTimeoutMs?: number
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
interface SequenceState {
  readonly scope: RpcChildScope
  sequence: number
  activated: boolean
  readonly calls: Set<string>
  readonly executed: Set<string>
}
interface HostGrant {
  readonly run: RpcChildRun
  readonly call: RpcChildCall
  readonly permit: RpcChildApprovalPermit
}
interface HostExecution {
  readonly run: RpcChildRun
  readonly call: RpcChildCall
  readonly permit: RpcChildApprovalPermit
  readonly committed: Promise<boolean>
  consuming?: boolean
  finish(written: boolean): void
}
type DecisionRequest = Exclude<RpcChildRequest, { operation: 'cancel' }>
/** Authenticated private child exchanges never mint main execution authority. */
export class RpcChildAuthority {
  readonly registry: RpcChildRunRegistry
  private readonly approval: RpcChildApprovalBridge
  #capability: Buffer
  private readonly scopes = new Map<string, SequenceState>()
  private readonly seen = new Set<string>()
  private readonly grants = new Map<string, RpcChildApprovalPermit>()
  private readonly submitted = new Set<string>()
  private readonly cancellations = new Map<string, Promise<void>>()
  private readonly nativeCancellations = new Map<string, Promise<void>>()
  private readonly hostGrants = new Map<string, HostGrant>()
  private readonly hostResults = new Map<string, HostExecution>()
  private readonly hostWork = new Map<
    string,
    { run: RpcChildRun; promise: Promise<RpcChildReply> }
  >()
  private readonly consumed = new Set<string>()
  private disposed = false
  private readonly cancelNativeChild: RpcChildAuthorityOptions['cancelNativeChild']
  readonly signal: AbortSignal
  private readonly cancellationTimeoutMs: number
  private readonly executeHost: RpcChildAuthorityOptions['executeHost']
  private readonly hostResultConsumed: RpcChildAuthorityOptions['hostResultConsumed']
  private readonly drainHost: RpcChildAuthorityOptions['drainHost']
  private readonly abort = (): void => this.dispose()

  constructor(options: RpcChildAuthorityOptions) {
    if (typeof options.cancelNativeChild !== 'function')
      throw new Error('Child authority requires scoped native cancellation')
    this.cancelNativeChild = options.cancelNativeChild
    this.signal = options.signal
    this.executeHost = options.executeHost
    this.hostResultConsumed = options.hostResultConsumed
    this.drainHost = options.drainHost
    this.cancellationTimeoutMs = options.cancellationTimeoutMs ?? 10000
    if (
      !Number.isSafeInteger(this.cancellationTimeoutMs) ||
      this.cancellationTimeoutMs < 1 ||
      this.cancellationTimeoutMs > 30000
    )
      throw new Error('Invalid child cancellation deadline')
    if (!executionCapability(options.capability))
      throw new Error('Invalid child authority capability')
    if (
      JSON.stringify({
        identity: options.identity,
        manifestBinding: options.manifestBinding,
        profiles: options.profiles
      }).includes(options.capability)
    )
      throw new Error('Child capability overlaps public profile')
    this.#capability = Buffer.from(options.capability, 'hex')
    this.registry = new RpcChildRunRegistry(options)
    this.approval = new RpcChildApprovalBridge(this.registry, options.approval)
    options.signal.addEventListener('abort', this.abort, { once: true })
    if (options.signal.aborted) this.dispose()
  }
  observe(frame: RpcFrame): void {
    this.registry.observe(frame)
  }
  /** Synchronous admission reserves ordering; the returned approval has no human deadline. */
  accept(input: RpcChildRequest, signal: AbortSignal): Promise<RpcChildReply> | undefined {
    const request = parseRpcChildRequest(JSON.stringify(input))
    const capability = Buffer.from(request.capability, 'hex')
    if (
      this.disposed ||
      signal.aborted ||
      capability.length !== this.#capability.length ||
      !timingSafeEqual(capability, this.#capability)
    )
      throw new Error('Child authority unavailable')
    if (this.seen.has(request.id) || this.seen.size >= MAX_RPC_CHILD_CALLS)
      throw new Error('Child request replay or capacity exhausted')
    this.seen.add(request.id)
    let state = this.scopes.get(request.scope.nativeAgentId)
    if (request.operation === 'register') {
      if (state || request.sequence !== 1) throw new Error('Invalid child registration sequence')
      state = {
        scope: request.scope,
        sequence: 1,
        activated: false,
        calls: new Set(),
        executed: new Set()
      }
      this.scopes.set(request.scope.nativeAgentId, state)
      return Promise.resolve(this.reply(request, this.registry.register(request.scope)))
    }
    if (
      !state ||
      !sameRpcChildScope(state.scope, request.scope) ||
      request.sequence !== state.sequence + 1
    ) {
      if (state && sameRpcChildScope(state.scope, request.scope))
        this.registry.cancelChild(state.scope)
      throw new Error('Invalid child request sequence or binding')
    }
    state.sequence = request.sequence
    if (request.operation === 'cancel') return undefined
    if (request.operation === 'activate') {
      if (state.activated || request.sequence !== 2) throw new Error('Child activation replay')
      state.activated = true
      return this.registry
        .activate(request.scope, request.actual, signal)
        .then((run) => this.reply(request, !!run && !signal.aborted))
    }
    if (request.operation === 'result_consumed') {
      const executed = this.hostResults.get(request.invocationId)
      if (
        !executed ||
        executed.consuming ||
        !this.hostResultConsumed ||
        !sameRpcChildScope(executed.run.scope, request.scope) ||
        executed.call.inputDigest !== request.call.inputDigest ||
        executed.call.toolCallId !== request.call.toolCallId
      )
        throw new Error('Child result consumption is not bound to its execution')
      executed.consuming = true
      return withRemoteSignal(executed.committed, signal)
        .then(async (written) => {
          if (!written) return this.reply(request, false)
          await this.hostResultConsumed!(executed.run, executed.call, request.invocationId)
          this.hostResults.delete(request.invocationId)
          this.consumed.add(request.id)
          return this.reply(request, true)
        })
        .finally(() => {
          executed.consuming = false
        })
    }
    const run = this.registry.current(request.scope)
    if (request.operation === 'execute') {
      if (
        !state.activated ||
        !run ||
        !this.executeHost ||
        !this.hostResultConsumed ||
        this.registry.toolSite(run.scope, request.call.toolName) !== 'host' ||
        state.executed.has(request.call.toolCallId)
      )
        throw new Error('Child host execution is unavailable')
      state.executed.add(request.call.toolCallId)
      const key = JSON.stringify([request.scope.nativeAgentId, request.call.toolCallId])
      const grant = this.hostGrants.get(key)
      this.hostGrants.delete(key)
      if (!grant || grant.run !== run || grant.call.inputDigest !== request.call.inputDigest)
        throw new Error('Child host execution lacks its committed approval')
      const joined = AbortSignal.any([signal, run.signal, this.signal])
      const operation = Promise.resolve()
        .then(async (): Promise<RpcChildReply> => {
          if (
            !(await withRemoteSignal(grant.permit.committed, joined)) ||
            !grant.permit.canExecute()
          )
            return this.reply(request, false)
          joined.throwIfAborted()
          const payload = await this.executeHost!(run, request.call, request.id, joined)
          if (
            !validHostResultPayload(payload) ||
            !isHostResultPlaceholder(payload.content) ||
            payload.isError !== true ||
            (payload.details !== undefined && payload.details !== null)
          )
            throw new Error('Child host execution requires private result delivery')
          if (
            joined.aborted ||
            this.registry.current(run.scope) !== run ||
            !grant.permit.canExecute()
          ) {
            await this.hostResultConsumed!(run, request.call, request.id)
            return this.reply(request, false)
          }
          let finish!: (written: boolean) => void
          const committed = new Promise<boolean>((resolve) => {
            finish = resolve
          })
          this.hostResults.set(request.id, {
            run,
            call: request.call,
            permit: grant.permit,
            committed,
            finish
          })
          return Object.freeze({
            ...this.reply(request, true),
            result: { runId: run.id, invocationId: request.id, payload }
          })
        })
        .catch(() => this.reply(request, false))
        .finally(() => {
          this.hostWork.delete(request.id)
        })
      this.hostWork.set(request.id, { run, promise: operation })
      return operation
    }
    if (
      !state.activated ||
      !run ||
      state.calls.has(request.call.toolCallId) ||
      state.calls.size >= MAX_RPC_CHILD_CALLS
    )
      throw new Error('Child tool origin replay or unavailable')
    state.calls.add(request.call.toolCallId)
    const permit = this.approval.prepare(run, request.call, signal)
    this.grants.set(request.id, permit)
    if (this.registry.toolSite(run.scope, request.call.toolName) === 'host')
      this.hostGrants.set(JSON.stringify([run.scope.nativeAgentId, request.call.toolCallId]), {
        run,
        call: request.call,
        permit
      })
    return permit.result.then((allowed) => this.reply(request, allowed && !signal.aborted))
  }
  canReply(request: DecisionRequest, reply: RpcChildReply): boolean {
    if (this.disposed || !reply.allowed) return false
    if (request.operation === 'register') return true
    const active = !!this.registry.current(request.scope)
    if (request.operation === 'result_consumed') return this.consumed.has(request.id)
    if (request.operation === 'execute')
      return active && this.hostResults.get(request.id)?.permit.canExecute() === true
    return request.operation === 'activate'
      ? active
      : active && !!this.grants.get(request.id)?.canCommit()
  }
  submitReply(request: DecisionRequest): void {
    if (this.grants.has(request.id)) this.submitted.add(request.id)
  }
  completeReply(request: DecisionRequest, written: boolean, allowed = false): void {
    const permit = this.grants.get(request.id)
    this.grants.delete(request.id)
    this.submitted.delete(request.id)
    permit?.finish(written, allowed)
    if (request.operation === 'approve' && (!written || !allowed))
      this.hostGrants.delete(JSON.stringify([request.scope.nativeAgentId, request.call.toolCallId]))
    if (request.operation === 'execute') {
      const result = this.hostResults.get(request.id)
      result?.finish(written && allowed)
      if (result && (!written || !allowed)) {
        this.hostResults.delete(request.id)
        void Promise.resolve(this.hostResultConsumed?.(result.run, result.call, request.id)).catch(
          () => undefined
        )
      }
    }
    if (request.operation === 'result_consumed') this.consumed.delete(request.id)
  }
  cancelParent(runId: string): Promise<void> {
    if (this.disposed || this.signal.aborted)
      return Promise.reject(new Error('Child cancellation authority is unavailable'))
    const pending = this.cancellations.get(runId)
    if (pending) return pending
    const nativeIds = this.registry.nativeChildren(runId)
    this.registry.cancelParent(runId)
    const attempt = Promise.resolve()
      .then(async () => {
        const results = await Promise.allSettled(nativeIds.map((id) => this.cancelChild(id)))
        const host = await Promise.allSettled(
          this.registry
            .records()
            .filter((child) => child.parentRunId === runId)
            .map((child) => this.drainHostExecutions(child.id))
        )
        if ([...results, ...host].some((result) => result.status === 'rejected'))
          throw new Error('Native child cancellation was not confirmed')
      })
      .finally(() => {
        if (this.cancellations.get(runId) === attempt) this.cancellations.delete(runId)
      })
    this.cancellations.set(runId, attempt)
    return attempt
  }
  /** Child and parent controls share one physical cancellation attempt per native identity. */
  cancelChild(nativeId: string): Promise<void> {
    if (this.disposed || this.signal.aborted)
      return Promise.reject(new Error('Child cancellation authority is unavailable'))
    const known = this.nativeCancellations.get(nativeId)
    if (known) return known
    const record = this.registry.recordForNative(nativeId)
    if (!record) return Promise.reject(new Error('Native child is not owned by this generation'))
    if (record.status === 'aborted') return this.drainHostExecutions(record.id)
    if (record.status === 'completed' || record.status === 'failed')
      return Promise.reject(new Error('Native child has already finished'))
    this.registry.revokeNative(nativeId)
    let confirmed = false
    const attempt = Promise.resolve()
      .then(async () => {
        const cancelled = AbortSignal.any([
          this.signal,
          AbortSignal.timeout(this.cancellationTimeoutMs)
        ])
        const confirmation = Promise.resolve().then(() => {
          cancelled.throwIfAborted()
          return this.cancelNativeChild(nativeId)
        })
        let failure: unknown
        try {
          if ((await withRemoteSignal(confirmation, cancelled)) !== true)
            throw new Error('Native cancellation refused')
          if ((await this.registry.waitForTerminal(nativeId, cancelled)) !== 'aborted')
            throw new Error('Native aborted lifecycle absent')
        } catch (error) {
          failure = error
        }
        try {
          await this.drainHostExecutions(record.id)
        } catch (error) {
          failure ??= error
        }
        if (failure) throw failure
        confirmed = true
      })
      .finally(() => {
        if (!confirmed && this.nativeCancellations.get(nativeId) === attempt)
          this.nativeCancellations.delete(nativeId)
      })
    this.nativeCancellations.set(nativeId, attempt)
    return attempt
  }
  async drainHostExecutions(childRunId?: string): Promise<void> {
    const work = [...this.hostWork.values()].filter(
      (item) => !childRunId || item.run.id === childRunId
    )
    await Promise.allSettled(work.map((item) => item.promise))
    await this.drainHost?.(childRunId)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.signal.removeEventListener('abort', this.abort)
    this.#capability.fill(0)
    this.registry.dispose()
    this.scopes.clear()
    this.hostGrants.clear()
    for (const result of this.hostResults.values()) result.finish(false)
    this.hostResults.clear()
    this.consumed.clear()
    this.nativeCancellations.clear()
    this.seen.clear()
    for (const [id, permit] of [...this.grants]) {
      if (this.submitted.has(id)) continue
      this.grants.delete(id)
      permit.finish(false)
    }
  }
  private reply(request: DecisionRequest, allowed: boolean): RpcChildReply {
    return Object.freeze({
      schema: 1,
      id: request.id,
      operation: request.operation,
      sequence: request.sequence,
      allowed
    })
  }
}
