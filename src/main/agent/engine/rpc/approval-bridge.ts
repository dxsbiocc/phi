import { randomUUID } from 'node:crypto'
import type { ToolApprovalRequest } from '../../tool-approval'
import {
  approvalIdentifier,
  parseApprovalEnvelope,
  RPC_APPROVAL_TITLE,
  sameApprovalIdentity,
  validApprovalIdentity,
  type RpcApprovalEnvelope,
  type RpcApprovalIdentity
} from '../phi-extension/lib/rpc-approval-protocol'
import { RpcConnection } from './connection'
import type { RpcControlChannel, RpcFrame } from './types'

export type RpcApprovalDecision = 'approved' | 'denied' | 'cancelled'
export interface RpcApprovalRun {
  readonly id: string
  readonly signal: AbortSignal
  /** Must correlate an attested main tool_call and its effective input, not trust the dialog. */
  authorizeCall(
    toolCallId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    digest: string,
    signal: AbortSignal
  ): 'main' | 'child' | undefined | Promise<'main' | 'child' | undefined>
}
export interface RpcApprovalScope extends Omit<RpcApprovalIdentity, 'runId' | 'generation'> {
  projectName?: string
  currentRun(): RpcApprovalRun | undefined
}
export interface RpcApprovalEvent {
  type: 'approval_requested' | 'approval_approved' | 'approval_denied' | 'approval_cancelled'
  approvalId: string
  sessionId: string
  runId: string
  toolCallId: string
  request: Readonly<ToolApprovalRequest>
}
export interface RpcApprovalBridgeOptions {
  connection: RpcConnection
  scope: RpcApprovalScope
  /** Reads the current project policy on each call; missing/failed policy denies. */
  shouldGate(request: Readonly<ToolApprovalRequest>): boolean
  /** Existing UI/runner adapter. Window loss must resolve cancelled or abort signal. */
  requestToolApproval(
    request: Readonly<ToolApprovalRequest>,
    signal: AbortSignal
  ): RpcApprovalDecision | Promise<RpcApprovalDecision>
  signal?: AbortSignal
  onEvent?(event: RpcApprovalEvent): void | Promise<void>
  onError?(error: Error): void
}
interface Pending {
  wireId: string
  envelope: RpcApprovalEnvelope
  run: RpcApprovalRun
  runSignal: AbortSignal
  authority: RpcApprovalRun['authorizeCall']
  controller: AbortController
  detach(): void
  request?: Readonly<ToolApprovalRequest>
  settled: boolean
}
const bound = new WeakMap<RpcConnection, number>()
const nativeTools = new Set(['write', 'edit', 'bash', 'powershell'])

/** Adapts one attested main connection to Phi's existing approval UI and run callbacks. */
export class RpcApprovalBridge {
  private readonly channel: RpcControlChannel
  private readonly scope: RpcApprovalScope
  private readonly pending = new Map<string, Pending>()
  private readonly seen = new Set<string>()
  private readonly seenCalls = new Set<string>()
  private readonly cleanup: Array<() => void> = []
  private disposed = false
  private exhausted = false

  constructor(private readonly options: RpcApprovalBridgeOptions) {
    this.channel = options.connection.bindControl()
    this.scope = Object.freeze({
      ...options.scope,
      currentRun: options.scope.currentRun.bind(options.scope)
    })
    if (
      !validApprovalIdentity({
        ...this.scope,
        generation: this.channel.generation,
        runId: 'validate-scope'
      })
    )
      throw new Error('RPC approval requires trusted scope')
    if (
      typeof options.shouldGate !== 'function' ||
      typeof options.requestToolApproval !== 'function'
    )
      throw new Error('RPC approval requires live policy/UI callbacks')
    if (bound.get(options.connection) === this.channel.generation)
      throw new Error('RPC approval already bound in this generation')
    bound.set(options.connection, this.channel.generation)
    this.cleanup.push(this.channel.onFrame((frame) => this.receive(frame)))
    for (const signal of [this.channel.signal, options.signal]) {
      if (this.disposed) break
      if (!signal) continue
      const abort = (): void => this.dispose()
      signal.addEventListener('abort', abort, { once: true })
      this.cleanup.push(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) this.dispose()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const item of [...this.pending.values()]) this.settle(item, 'cancelled', true)
    for (const detach of this.cleanup.splice(0)) detach()
    this.seen.clear()
    this.seenCalls.clear()
  }

  private receive(frame: RpcFrame): void {
    if (this.disposed || frame.type !== 'extension_ui_request') return
    try {
      if (frame.method === 'cancel') {
        if (typeof frame.targetId === 'string') {
          const item = this.pending.get(frame.targetId)
          if (item) this.settle(item, 'cancelled', false)
        }
        return
      }
      if (!approvalIdentifier(frame.id) || this.seen.has(frame.id)) return
      if (!['confirm', 'select', 'input', 'editor', 'ask'].includes(String(frame.method))) return
      if (this.exhausted || this.seen.size >= 10000) {
        // Keep a bounded rejection listener alive until generation retirement;
        // silently detaching would strand this and subsequent SDK dialogs.
        this.exhausted = true
        for (const item of [...this.pending.values()]) this.settle(item, 'cancelled', true)
        this.seen.clear()
        this.seenCalls.clear()
        void this.reply(frame.id, 'cancelled')
        return
      }
      this.seen.add(frame.id)
      const envelope =
        frame.method === 'confirm' &&
        frame.title === RPC_APPROVAL_TITLE &&
        frame.timeout === undefined
          ? parseApprovalEnvelope(frame.message)
          : undefined
      const callKey = envelope ? JSON.stringify([envelope.runId, envelope.toolCallId]) : ''
      const run = this.scope.currentRun()
      const expected = run && { ...this.scope, generation: this.channel.generation, runId: run.id }
      if (
        !envelope ||
        !run ||
        !expected ||
        run.signal.aborted ||
        !sameApprovalIdentity(envelope, expected) ||
        !nativeTools.has(envelope.toolName) ||
        this.seenCalls.has(callKey) ||
        this.pending.size >= 64
      ) {
        this.reply(frame.id, 'cancelled')
        return
      }
      this.seenCalls.add(callKey)
      const item: Pending = {
        wireId: frame.id,
        envelope,
        run,
        runSignal: run.signal,
        authority: run.authorizeCall,
        controller: new AbortController(),
        detach: () => {},
        settled: false
      }
      this.pending.set(item.wireId, item)
      const abort = (): void => this.settle(item, 'cancelled', true)
      run.signal.addEventListener('abort', abort, { once: true })
      item.detach = () => run.signal.removeEventListener('abort', abort)
      if (run.signal.aborted) abort()
      else
        void this.admit(item).catch((error) => {
          this.error(error)
          this.settle(item, 'denied', true)
        })
    } catch (error) {
      this.error(error)
      if (approvalIdentifier(frame.id)) {
        const item = this.pending.get(frame.id)
        if (item) this.settle(item, 'cancelled', true)
        else this.reply(frame.id, 'cancelled')
      }
    }
  }

  private active(item: Pending): boolean {
    const current = this.scope.currentRun()
    return (
      !this.disposed &&
      !this.exhausted &&
      !item.settled &&
      !this.channel.signal.aborted &&
      !item.controller.signal.aborted &&
      current === item.run &&
      current.id === item.envelope.runId &&
      current.signal === item.runSignal &&
      !current.signal.aborted &&
      current.authorizeCall === item.authority
    )
  }

  private async admit(item: Pending): Promise<void> {
    const e = item.envelope
    const authority = await this.untilCancelled(
      item,
      item.authority.call(
        item.run,
        e.toolCallId,
        e.toolName,
        e.input,
        e.inputDigest,
        item.controller.signal
      )
    )
    if (!this.active(item)) {
      this.settle(item, 'cancelled', true)
      return
    }
    if (authority !== 'main') {
      this.settle(item, 'denied', true)
      return
    }
    const request: Readonly<ToolApprovalRequest> = Object.freeze({
      requestId: randomUUID(),
      sessionId: this.scope.phiSessionId,
      sessionGeneration: this.channel.generation,
      runId: item.run.id,
      cwd: this.scope.cwd,
      ...(this.scope.projectName ? { projectName: this.scope.projectName } : {}),
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      approvalDigest: e.inputDigest,
      ...(typeof e.input.command === 'string' ? { command: e.input.command } : {}),
      summary:
        typeof e.input.command === 'string'
          ? e.input.command
          : typeof e.input.path === 'string'
            ? `${e.toolName}: ${e.input.path}`
            : e.toolName
    })
    const gate = this.options.shouldGate(request)
    if (typeof gate !== 'boolean') {
      this.settle(item, 'denied', true)
      return
    }
    if (!this.active(item)) {
      this.settle(item, 'cancelled', true)
      return
    }
    if (!gate) {
      this.settle(item, 'approved', true)
      return
    }
    item.request = request
    this.event(item, 'approval_requested')
    if (!this.active(item)) {
      this.settle(item, 'cancelled', true)
      return
    }
    let decision: RpcApprovalDecision
    try {
      decision =
        (await this.untilCancelled(
          item,
          this.options.requestToolApproval(request, item.controller.signal)
        )) ?? 'cancelled'
    } catch (error) {
      this.error(error)
      decision = 'denied'
    }
    if (!this.active(item)) {
      this.settle(item, 'cancelled', true)
      return
    }
    // A UI callback cannot mutate approved input. Reauthorize its exact binding after the wait.
    if (decision === 'approved') {
      const stillMain = await this.untilCancelled(
        item,
        item.authority.call(
          item.run,
          e.toolCallId,
          e.toolName,
          e.input,
          e.inputDigest,
          item.controller.signal
        )
      )
      if (!this.active(item)) {
        this.settle(item, 'cancelled', true)
        return
      }
      if (stillMain !== 'main') decision = 'denied'
    }
    this.settle(
      item,
      ['approved', 'denied', 'cancelled'].includes(decision) ? decision : 'denied',
      true
    )
  }

  private untilCancelled<T>(item: Pending, task: T | Promise<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false
      const signal = item.controller.signal
      const finish = (error: unknown, value?: T): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(value)
      }
      const abort = (): void => finish(undefined)
      signal.addEventListener('abort', abort, { once: true })
      // Observe even a retired rejected task; no injected promise may escape unhandled.
      void Promise.resolve(task).then(
        (value) => finish(undefined, value),
        (error) => finish(error || new Error('Approval callback rejected'))
      )
      if (signal.aborted) abort()
    })
  }

  private liveBinding(item: Pending): boolean {
    try {
      const current = this.scope.currentRun()
      return (
        !this.disposed &&
        !this.exhausted &&
        !this.channel.signal.aborted &&
        !this.options.signal?.aborted &&
        current === item.run &&
        current.id === item.envelope.runId &&
        current.signal === item.runSignal &&
        !current.signal.aborted &&
        current.authorizeCall === item.authority
      )
    } catch (error) {
      this.error(error)
      return false
    }
  }

  private settle(item: Pending, decision: RpcApprovalDecision, respond: boolean): void {
    if (item.settled) return
    item.settled = true
    this.pending.delete(item.wireId)
    item.detach()
    item.controller.abort()
    // Abort listeners are user code too. Check again immediately before enqueueing allow.
    const outcome = decision === 'approved' && !this.liveBinding(item) ? 'cancelled' : decision
    if (!respond) {
      this.event(item, `approval_${outcome}`)
      return
    }
    // The response is the decision's commit point. Notify observers only after it
    // is written, so reentrant retirement can never be followed by a new allow.
    void this.reply(item.wireId, outcome).then((written) => {
      this.event(item, `approval_${written ? outcome : 'cancelled'}`)
    })
  }
  private async reply(id: string, decision: RpcApprovalDecision): Promise<boolean> {
    if (this.channel.signal.aborted) return false
    const frame =
      decision === 'cancelled'
        ? { type: 'extension_ui_response' as const, id, cancelled: true as const }
        : { type: 'extension_ui_response' as const, id, confirmed: decision === 'approved' }
    try {
      await this.channel.sendControl(frame)
      return true
    } catch (error) {
      this.error(error)
      return false
    }
  }
  private event(item: Pending, type: RpcApprovalEvent['type']): void {
    const request = item.request
    if (!request) return
    try {
      void Promise.resolve(
        this.options.onEvent?.({
          type,
          approvalId: request.requestId,
          sessionId: this.scope.phiSessionId,
          runId: item.envelope.runId,
          toolCallId: item.envelope.toolCallId,
          request
        })
      ).catch((error) => this.error(error))
    } catch (error) {
      this.error(error)
    }
  }
  private error(error: unknown): void {
    try {
      void Promise.resolve(
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      ).catch(() => {})
    } catch {
      /* Diagnostic callbacks cannot replace approval decisions. */
    }
  }
}
