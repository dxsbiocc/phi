import {
  PHI_KERNEL_PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
  type HostRequestFrame,
  type JsonValue,
  type KernelEventFrame,
  type KernelHelloResult,
  type KernelRequestFrame,
  type KernelV1Method,
  type ProtocolError,
  type ProtocolErrorCode
} from '../../../../shared/kernel-protocol'

export interface KernelClientTransport {
  send(line: string): void
  onLine(callback: (line: string) => void): void
  onClose(callback: () => void): void
  close?(): void | Promise<void>
}

export type KernelRequestContext = Pick<
  KernelRequestFrame,
  'sessionId' | 'runId' | 'conversationId' | 'taskId'
>

export type KernelHostRequestContext = Pick<HostRequestFrame, 'sessionId' | 'agentRunId'>

export type KernelHostHandler = (
  params: JsonValue,
  context: KernelHostRequestContext
) => JsonValue | Promise<JsonValue>

export class KernelClientError extends Error {
  readonly code: ProtocolErrorCode
  readonly detail?: JsonValue

  constructor(error: ProtocolError) {
    super(error.message)
    this.name = 'KernelClientError'
    this.code = error.code
    this.detail = error.detail
  }
}

type PendingRequest = {
  resolve(value: JsonValue): void
  reject(error: Error): void
}

function internalError(message: string): KernelClientError {
  return new KernelClientError({ code: 'INTERNAL', message })
}

function protocolError(error: unknown): ProtocolError {
  if (error instanceof KernelClientError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail })
    }
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error)
  }
}

export class KernelProtocolClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: KernelEventFrame) => void>()
  private readonly hostHandlers = new Map<string, KernelHostHandler>()
  private requestCounter = 0
  private generation = 0
  private closed = false

  constructor(private readonly transport: KernelClientTransport) {
    transport.onLine((line) => this.handleLine(line))
    transport.onClose(() => this.handleClose())
  }

  get controllerGeneration(): number {
    return this.generation
  }

  async hello(
    options: {
      client?: { name: string; version: string }
      hostCapabilities?: string[]
      takeover?: boolean
    } = {}
  ): Promise<KernelHelloResult> {
    const result = await this.sendRequest(
      'kernel.hello',
      {
        protocol: PHI_KERNEL_PROTOCOL_VERSION,
        client: options.client ?? { name: 'phi-kernel-client', version: '1.0.0' },
        ...(options.hostCapabilities ? { hostCapabilities: options.hostCapabilities } : {}),
        ...(options.takeover === undefined ? {} : { takeover: options.takeover })
      },
      {},
      0
    )
    const greeting = result as KernelHelloResult
    this.generation = greeting.controllerGeneration
    return greeting
  }

  request(
    method: Exclude<KernelV1Method, 'kernel.hello'>,
    params: JsonValue,
    context: KernelRequestContext = {}
  ): Promise<JsonValue> {
    if (this.generation === 0) {
      return Promise.reject(internalError('Kernel hello must complete before business requests.'))
    }
    return this.sendRequest(method, params, context, this.generation)
  }

  subscribe(afterSeq = 0): Promise<JsonValue> {
    return this.request('events.subscribe', { afterSeq })
  }

  onEvent(listener: (event: KernelEventFrame) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  registerHostHandler(capability: string, handler: KernelHostHandler): () => void {
    this.hostHandlers.set(capability, handler)
    return () => {
      if (this.hostHandlers.get(capability) === handler) this.hostHandlers.delete(capability)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.transport.close?.()
    this.rejectPending(internalError('Kernel client closed.'))
  }

  private sendRequest(
    method: KernelV1Method,
    params: JsonValue,
    context: KernelRequestContext,
    generation: number
  ): Promise<JsonValue> {
    if (this.closed) return Promise.reject(internalError('Kernel client is closed.'))
    const id = `client-${++this.requestCounter}`
    const frame: KernelRequestFrame = {
      kind: 'request',
      id,
      method,
      params,
      generation,
      ...context
    }
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.transport.send(encodeFrame(frame))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : internalError(String(error)))
      }
    })
  }

  private handleLine(line: string): void {
    const frame = parseFrame(line)
    if (!('kind' in frame)) {
      this.rejectPending(new KernelClientError(frame))
      return
    }
    if (frame.kind === 'response') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      if (frame.ok) pending.resolve(frame.result)
      else pending.reject(new KernelClientError(frame.error))
      return
    }
    if (frame.kind === 'event') {
      for (const listener of this.eventListeners) listener(frame)
      return
    }
    if (frame.kind === 'host.request') {
      void this.handleHostRequest(frame)
    }
  }

  private async handleHostRequest(frame: HostRequestFrame): Promise<void> {
    const handler = this.hostHandlers.get(frame.capability)
    if (!handler) {
      this.transport.send(
        encodeFrame({
          kind: 'host.response',
          id: frame.id,
          ok: false,
          error: {
            code: 'CAPABILITY_UNAVAILABLE',
            message: `Host capability is not registered: ${frame.capability}`
          }
        })
      )
      return
    }
    try {
      const result = await handler(frame.params, {
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        ...(frame.agentRunId ? { agentRunId: frame.agentRunId } : {})
      })
      this.transport.send(encodeFrame({ kind: 'host.response', id: frame.id, ok: true, result }))
    } catch (error) {
      this.transport.send(
        encodeFrame({ kind: 'host.response', id: frame.id, ok: false, error: protocolError(error) })
      )
    }
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(internalError('Kernel transport closed.'))
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export * from './stdio'
