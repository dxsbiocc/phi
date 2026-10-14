import { timingSafeEqual } from 'node:crypto'
import {
  MAX_RPC_CHILD_CALLS,
  parseRpcChildRequest,
  sameRpcChildScope,
  type RpcChildReply,
  type RpcChildRequest,
  type RpcChildScope
} from '../../phi-extension/lib/rpc-child-protocol'
import { executionCapability } from '../../phi-extension/lib/rpc-execution-protocol'
import type { RpcFrame } from '../types'
import { withRemoteSignal } from '../history-pager'
import {
  RpcChildApprovalBridge,
  type RpcChildApprovalOptions,
  type RpcChildApprovalPermit
} from './child-approval-bridge'
import { RpcChildRunRegistry, type RpcChildRegistryOptions } from './run-registry'

export interface RpcChildAuthorityOptions extends RpcChildRegistryOptions {
  readonly capability: string
  readonly approval: RpcChildApprovalOptions
  readonly cancelNativeChild: (nativeAgentId: string) => boolean | Promise<boolean>
  readonly cancellationTimeoutMs?: number
}
interface SequenceState {
  readonly scope: RpcChildScope
  sequence: number
  activated: boolean
  readonly calls: Set<string>
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
  private disposed = false
  private readonly cancelNativeChild: RpcChildAuthorityOptions['cancelNativeChild']
  readonly signal: AbortSignal
  private readonly cancellationTimeoutMs: number
  private readonly abort = (): void => this.dispose()

  constructor(options: RpcChildAuthorityOptions) {
    if (typeof options.cancelNativeChild !== 'function')
      throw new Error('Child authority requires scoped native cancellation')
    this.cancelNativeChild = options.cancelNativeChild
    this.signal = options.signal
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
      state = { scope: request.scope, sequence: 1, activated: false, calls: new Set() }
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
    const run = this.registry.current(request.scope)
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
    return permit.result.then((allowed) => this.reply(request, allowed && !signal.aborted))
  }
  canReply(request: DecisionRequest, reply: RpcChildReply): boolean {
    if (this.disposed || !reply.allowed) return false
    if (request.operation === 'register') return true
    const active = !!this.registry.current(request.scope)
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
        const cancelled = AbortSignal.any([
          this.signal,
          AbortSignal.timeout(this.cancellationTimeoutMs)
        ])
        const results = await Promise.allSettled(
          nativeIds.map(async (id) => {
            const confirmation = Promise.resolve().then(() => {
              cancelled.throwIfAborted()
              return this.cancelNativeChild(id)
            })
            if ((await withRemoteSignal(confirmation, cancelled)) !== true)
              throw new Error('Native cancellation refused')
            if ((await this.registry.waitForTerminal(id, cancelled)) !== 'aborted')
              throw new Error('Native aborted lifecycle absent')
          })
        )
        if (results.some((result) => result.status === 'rejected'))
          throw new Error('Native child cancellation was not confirmed')
      })
      .finally(() => {
        if (this.cancellations.get(runId) === attempt) this.cancellations.delete(runId)
      })
    this.cancellations.set(runId, attempt)
    return attempt
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.signal.removeEventListener('abort', this.abort)
    this.#capability.fill(0)
    this.registry.dispose()
    this.scopes.clear()
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
