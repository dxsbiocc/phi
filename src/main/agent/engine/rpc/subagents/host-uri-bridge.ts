import {
  MAX_RPC_CHILD_CALLS,
  parseRpcChildRequest,
  parseRpcChildUri,
  sameRpcChildScope,
  type RpcChildReply,
  type RpcChildRequest
} from '../../phi-extension/lib/rpc-child-protocol'
import { rpcIdentifier } from '../control-frame'
import type { RpcControlChannel, RpcFrame } from '../types'
import type { RpcChildAuthority } from './child-authority'

type DecisionRequest = Exclude<RpcChildRequest, { operation: 'cancel' }>
interface Exchange {
  readonly request: DecisionRequest
  readonly controller: AbortController
  readonly result: Promise<RpcChildReply>
  phase: 'prepared' | 'submitted' | 'finished'
  reader?: string
}
export interface RpcChildHostUriOptions {
  readonly channel: RpcControlChannel
  readonly authority: RpcChildAuthority
  readonly maxOutstanding?: number
}
const bound = new WeakSet<AbortSignal>()
/** Only the reserved protocol is handled, through the same bounded generation writer. */
export class RpcChildHostUriBridge {
  private readonly exchanges = new Map<string, Exchange>()
  private readonly wires = new Map<string, Exchange>()
  private readonly seen = new Set<string>()
  private readonly maximum: number
  private disposed = false
  private readonly detach: () => void
  private readonly abort = (): void => this.dispose()

  constructor(private readonly options: RpcChildHostUriOptions) {
    this.options = Object.freeze({ ...options })
    this.maximum = options.maxOutstanding ?? 64
    if (
      !Number.isSafeInteger(this.maximum) ||
      this.maximum < 1 ||
      this.maximum > 256 ||
      options.authority.registry.identity.generation !== options.channel.generation ||
      options.authority.signal !== options.channel.signal ||
      bound.has(options.channel.signal)
    )
      throw new Error('Invalid child URI capacity')
    bound.add(options.channel.signal)
    this.detach = options.channel.onFrame((frame) => this.receive(frame))
    options.channel.signal.addEventListener('abort', this.abort, { once: true })
    if (options.channel.signal.aborted) this.dispose()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detach()
    this.options.channel.signal.removeEventListener('abort', this.abort)
    for (const exchange of [...this.exchanges.values()]) this.retire(exchange)
    this.exchanges.clear()
    this.wires.clear()
    this.seen.clear()
    this.options.authority.dispose()
  }
  private receive(frame: RpcFrame): void {
    if (this.disposed) return
    if (frame.type === 'host_uri_cancel') {
      if (!rpcIdentifier(frame.targetId)) return
      const exchange = this.wires.get(frame.targetId)
      if (exchange) this.retire(exchange)
      return
    }
    if (
      frame.type !== 'host_uri_request' ||
      typeof frame.url !== 'string' ||
      !/^phi-child:/iu.test(frame.url) ||
      !rpcIdentifier(frame.id)
    )
      return
    if (this.seen.has(frame.id)) return
    if (this.seen.size >= MAX_RPC_CHILD_CALLS * 3) {
      void this.error(frame.id)
      for (const exchange of [...this.exchanges.values()]) this.retire(exchange)
      return
    }
    this.seen.add(frame.id)
    void this.handle(frame, frame.id).catch(() => this.error(frame.id as string))
  }
  private async handle(frame: RpcFrame, wireId: string): Promise<void> {
    const uri = parseRpcChildUri(frame.url)
    if (uri.part === 'reply') {
      if (frame.operation !== 'read' || frame.content !== undefined)
        throw new Error('Invalid child reply read')
      const exchange = this.exchanges.get(uri.id)
      if (!exchange || exchange.reader) throw new Error('Unknown or consumed child reply')
      exchange.reader = wireId
      this.wires.set(wireId, exchange)
      try {
        const reply = await exchange.result
        if (
          this.disposed ||
          exchange.controller.signal.aborted ||
          this.exchanges.get(uri.id) !== exchange
        )
          return
        const allowed = reply.allowed && this.options.authority.canReply(exchange.request, reply)
        const current = (): boolean =>
          !this.disposed &&
          !exchange.controller.signal.aborted &&
          this.exchanges.get(uri.id) === exchange
        await this.options.channel.sendControl(
          {
            type: 'host_uri_result',
            id: wireId,
            content: JSON.stringify({ ...reply, allowed }),
            contentType: 'application/json',
            immutable: true
          },
          {
            canSubmit: () =>
              current() &&
              (!allowed || this.options.authority.canReply(exchange.request, reply)) &&
              current(),
            onSubmit: () => {
              exchange.phase = 'submitted'
              this.options.authority.submitReply(exchange.request)
            }
          }
        )
        exchange.phase = 'finished'
        this.options.authority.completeReply(exchange.request, true, allowed)
      } catch (error) {
        exchange.phase = 'finished'
        this.options.authority.completeReply(exchange.request, false)
        throw error
      } finally {
        this.retire(exchange)
      }
      return
    }
    if (frame.operation !== 'write' || typeof frame.content !== 'string')
      throw new Error('Invalid child request write')
    const request = parseRpcChildRequest(frame.content)
    if (request.id !== uri.id || (request.operation === 'cancel') !== (uri.part === 'cancel'))
      throw new Error('Invalid child URI request binding')
    if (request.operation === 'cancel') {
      this.options.authority.accept(request, this.options.channel.signal)
      const target = this.exchanges.get(request.targetId)
      if (target && sameRpcChildScope(target.request.scope, request.scope)) this.retire(target)
      await this.options.channel.sendControl({ type: 'host_uri_result', id: wireId })
      return
    }
    if (this.exchanges.has(request.id) || this.exchanges.size >= this.maximum)
      throw new Error('Child URI exchange capacity exhausted')
    const controller = new AbortController()
    const result = this.options.authority.accept(request, controller.signal)
    if (!result) throw new Error('Child URI decision absent')
    // Observe immediately, even when a cancelled client never performs its read.
    void result.catch(() => undefined)
    const exchange: Exchange = { request, controller, result, phase: 'prepared' }
    this.exchanges.set(request.id, exchange)
    this.wires.set(wireId, exchange)
    try {
      await this.options.channel.sendControl({ type: 'host_uri_result', id: wireId })
      this.wires.delete(wireId)
    } catch (error) {
      this.retire(exchange)
      throw error
    }
  }
  private retire(exchange: Exchange): void {
    if (this.exchanges.get(exchange.request.id) !== exchange) return
    this.exchanges.delete(exchange.request.id)
    if (exchange.phase === 'prepared') this.options.authority.completeReply(exchange.request, false)
    for (const [id, owner] of this.wires) if (owner === exchange) this.wires.delete(id)
    exchange.controller.abort()
  }
  private async error(id: string): Promise<void> {
    if (this.disposed || this.options.channel.signal.aborted) return
    try {
      await this.options.channel.sendControl({
        type: 'host_uri_result',
        id,
        isError: true,
        error: 'Private child request refused'
      })
    } catch {
      /* Generation retirement owns failed writes; no alternate channel is opened. */
    }
  }
}
