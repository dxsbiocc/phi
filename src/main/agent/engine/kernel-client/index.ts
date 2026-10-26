import {
  KERNEL_EVENT_INTERACTION_CANCELLED,
  KERNEL_HOST_CAPABILITY_REGISTRY,
  PHI_KERNEL_PROTOCOL_VERSION,
  encodeFrame,
  interactionCancelledPayloadSchema,
  isKernelHostCapabilityName,
  parseFrame,
  type HostRequestFrame,
  type HostProgressFrame,
  type JsonValue,
  type KernelHostCapabilityName,
  type KernelHostCapabilityParams,
  type KernelHostCapabilityResult,
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

export type KernelHostRequestContext = Pick<
  HostRequestFrame,
  'sessionId' | 'runId' | 'agentRunId'
> & {
  readonly signal: AbortSignal
  readonly progress?: (progress: JsonValue) => void
}

export type KernelHostHandler<Name extends KernelHostCapabilityName = KernelHostCapabilityName> = (
  params: KernelHostCapabilityParams<Name>,
  context: KernelHostRequestContext
) => KernelHostCapabilityResult<Name> | Promise<KernelHostCapabilityResult<Name>>

type UntypedKernelHostHandler = (
  params: JsonValue,
  context: KernelHostRequestContext
) => JsonValue | undefined | Promise<JsonValue | undefined>

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
  private readonly closeListeners = new Set<() => void>()
  private readonly hostHandlers = new Map<KernelHostCapabilityName, UntypedKernelHostHandler>()
  private readonly hostRequestControllers = new Map<string, AbortController>()
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

  onClose(listener: () => void): () => void {
    if (this.closed) queueMicrotask(listener)
    else this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  registerHostCapability<Name extends KernelHostCapabilityName>(
    capability: Name,
    handler: KernelHostHandler<Name>
  ): () => void {
    if (!isKernelHostCapabilityName(capability)) {
      throw new TypeError(`Unknown kernel host capability: ${capability}`)
    }
    const registered = handler as unknown as UntypedKernelHostHandler
    this.hostHandlers.set(capability, registered)
    return () => {
      if (this.hostHandlers.get(capability) === registered) this.hostHandlers.delete(capability)
    }
  }

  /** Compatibility alias for callers that have not migrated to the typed registration API yet. */
  registerHostHandler(capability: string, handler: UntypedKernelHostHandler): () => void {
    if (!isKernelHostCapabilityName(capability)) {
      throw new TypeError(`Unknown kernel host capability: ${capability}`)
    }
    return this.registerHostCapability(
      capability,
      handler as unknown as KernelHostHandler<typeof capability>
    )
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abortHostRequests('Kernel client closed.')
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
      if (frame.type === KERNEL_EVENT_INTERACTION_CANCELLED) {
        const cancelled = interactionCancelledPayloadSchema.safeParse(frame.payload)
        if (cancelled.success && cancelled.data.kind === 'host') {
          this.hostRequestControllers
            .get(cancelled.data.id)
            ?.abort(new Error(cancelled.data.reason))
        }
      }
      for (const listener of this.eventListeners) listener(frame)
      return
    }
    if (frame.kind === 'host.request') {
      void this.handleHostRequest(frame)
    }
  }

  private async handleHostRequest(frame: HostRequestFrame): Promise<void> {
    if (!isKernelHostCapabilityName(frame.capability)) {
      this.sendHostError(
        frame.id,
        'CAPABILITY_UNAVAILABLE',
        `Host capability is not registered: ${frame.capability}`
      )
      return
    }
    const handler = this.hostHandlers.get(frame.capability)
    if (!handler) {
      this.sendHostError(
        frame.id,
        'CAPABILITY_UNAVAILABLE',
        `Host capability is not registered: ${frame.capability}`
      )
      return
    }
    const parsedParams = KERNEL_HOST_CAPABILITY_REGISTRY[frame.capability].params.safeParse(
      frame.params
    )
    if (!parsedParams.success) {
      const issue = parsedParams.error.issues[0]
      this.sendHostError(frame.id, 'INVALID_PARAMS', 'Invalid host capability parameters.', {
        path: issue?.path.length ? issue.path.map(String).join('.') : '$'
      })
      return
    }
    if (this.hostRequestControllers.has(frame.id)) {
      this.sendHostError(frame.id, 'DUPLICATE_REQUEST', 'Duplicate host request identifier.')
      return
    }
    const controller = new AbortController()
    this.hostRequestControllers.set(frame.id, controller)
    try {
      const result = await handler(parsedParams.data as JsonValue, {
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        ...(frame.runId ? { runId: frame.runId } : {}),
        ...(frame.agentRunId ? { agentRunId: frame.agentRunId } : {}),
        signal: controller.signal,
        ...this.hostProgressContext(frame, controller)
      })
      if (controller.signal.aborted) return
      // Existing desktop handlers use `undefined` for void and absent optional values. The wire
      // format is JSON, so normalize those established results to the registry's explicit null.
      this.transport.send(
        encodeFrame({ kind: 'host.response', id: frame.id, ok: true, result: result ?? null })
      )
    } catch (error) {
      if (controller.signal.aborted) return
      this.transport.send(
        encodeFrame({ kind: 'host.response', id: frame.id, ok: false, error: protocolError(error) })
      )
    } finally {
      if (this.hostRequestControllers.get(frame.id) === controller) {
        this.hostRequestControllers.delete(frame.id)
      }
    }
  }

  private hostProgressContext(
    frame: HostRequestFrame,
    controller: AbortController
  ): Pick<KernelHostRequestContext, 'progress'> {
    const definition = KERNEL_HOST_CAPABILITY_REGISTRY[frame.capability]
    if (!('progress' in definition) || definition.progress !== true) return {}
    return {
      progress: (progress: JsonValue) => {
        if (controller.signal.aborted) return
        const progressFrame: HostProgressFrame = {
          kind: 'host.progress',
          id: frame.id,
          progress
        }
        this.transport.send(encodeFrame(progressFrame))
      }
    }
  }

  private sendHostError(
    id: string,
    code: ProtocolErrorCode,
    message: string,
    detail?: JsonValue
  ): void {
    this.transport.send(
      encodeFrame({
        kind: 'host.response',
        id,
        ok: false,
        error: { code, message, ...(detail === undefined ? {} : { detail }) }
      })
    )
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    this.abortHostRequests('Kernel transport closed.')
    this.rejectPending(internalError('Kernel transport closed.'))
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }

  private abortHostRequests(reason: string): void {
    for (const controller of this.hostRequestControllers.values()) {
      controller.abort(new Error(reason))
    }
    this.hostRequestControllers.clear()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export * from './stdio'
export * from './local'
