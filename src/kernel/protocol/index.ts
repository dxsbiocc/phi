import {
  KERNEL_EVENT_APPROVAL_REQUESTED,
  KERNEL_V1_METHODS,
  PHI_KERNEL_PROTOCOL_VERSION,
  approvalRequestedPayloadSchema,
  encodeFrame,
  kernelMethodResultSchemas,
  parseFrame,
  runCompletedPayloadSchema,
  type HostRequestFrame,
  type HostResponseFrame,
  type JsonValue,
  type KernelEventFrame,
  type KernelRequestFrame,
  type KernelResponseFrame,
  type ProtocolError
} from '../../shared/kernel-protocol'
import { makeProtocolError, normalizeHandlerError } from './errors'
import type {
  AttachTransportOptions,
  FrameTransport,
  KernelBusinessMethod,
  KernelCallContext,
  KernelHostRequestContext,
  KernelMethodHandler,
  KernelMethodHandlers,
  KernelProtocolLogger,
  KernelProtocolOptions,
  RunCompletionStatus,
  SessionPromptRun
} from './types'

export * from './types'

interface ConnectionState {
  readonly id: string
  readonly transport: FrameTransport
  readonly trusted: boolean
  hostCapabilities: ReadonlySet<string>
  readonly requestIds: Set<string>
  generation?: number
  negotiated: boolean
  liveEventsEnabled: boolean
  approvalIdsToReannounce: Set<string>
  closed: boolean
}

interface PendingHostRequest {
  readonly frame: HostRequestFrame
  connection?: ConnectionState
  generation?: number
  resolve(value: JsonValue): void
  reject(error: ProtocolError): void
}

type ActiveRunState =
  | {
      readonly phase: 'accepting'
      readonly token: number
      readonly settled: Promise<void>
      settle(): void
    }
  | { readonly phase: 'running'; readonly runId: string }

const businessMethods = new Set<string>(
  KERNEL_V1_METHODS.filter((method) => method !== 'kernel.hello')
)

function createKernelInstanceId(): string {
  return globalThis.crypto.randomUUID()
}

export class KernelProtocolCore {
  private readonly handlers: KernelMethodHandlers
  private readonly replayCapacity: number
  private readonly kernelInstanceId: string
  private readonly log: KernelProtocolLogger
  private readonly disconnectPolicy: 'fail-pending' | 'wait-for-reconnect'
  private readonly connections = new Map<string, ConnectionState>()
  private readonly replay: KernelEventFrame[] = []
  private readonly activeRuns = new Map<string, ActiveRunState>()
  private readonly terminalRuns = new Set<string>()
  private readonly pendingHostRequests = new Map<string, PendingHostRequest>()
  private readonly pendingApprovals = new Map<string, KernelEventFrame>()
  private readonly expiredPendingPrompts = new Set<number>()
  private readonly expiringRunIds = new Set<string>()
  private controller?: ConnectionState
  private connectionCounter = 0
  private hostRequestCounter = 0
  private promptCounter = 0
  private controllerGeneration = 0
  private lastSeq = 0

  constructor(private readonly options: KernelProtocolOptions) {
    this.handlers = options.handlers ?? {}
    this.replayCapacity = options.replayCapacity ?? 1024
    if (!Number.isInteger(this.replayCapacity) || this.replayCapacity < 1) {
      throw new RangeError('replayCapacity must be a positive integer')
    }
    this.kernelInstanceId = options.kernelInstanceId ?? createKernelInstanceId()
    this.log = options.log ?? {}
    this.disconnectPolicy = options.disconnectPolicy ?? 'fail-pending'
  }

  attachTransport(transport: FrameTransport, options: AttachTransportOptions): void {
    const connectionId = options.connectionId ?? `connection-${++this.connectionCounter}`
    if (this.connections.has(connectionId)) {
      throw new Error(`A kernel protocol connection already uses id ${connectionId}`)
    }

    const state: ConnectionState = {
      id: connectionId,
      transport,
      trusted: options.trusted,
      hostCapabilities: new Set(),
      requestIds: new Set(),
      negotiated: false,
      liveEventsEnabled: false,
      approvalIdsToReannounce: new Set(),
      closed: false
    }
    this.connections.set(connectionId, state)

    transport.onLine((line) => {
      if (state.closed) return
      try {
        this.processLine(state, line)
      } catch {
        this.log.error?.('Kernel protocol failed to process a frame.', {
          connectionId: state.id
        })
      }
    })
    transport.onClose(() => this.closeConnection(state))
  }

  emitEvent(
    type: string,
    payload: JsonValue,
    routing: { sessionId?: string; runId?: string } = {}
  ): KernelEventFrame | undefined {
    let terminalRunId: string | undefined
    let approvalId: string | undefined
    if (type === 'run.completed') {
      const parsed = runCompletedPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new TypeError('run.completed payload is invalid')
      }
      if (this.terminalRuns.has(parsed.data.runId)) {
        this.log.warn?.('Ignored duplicate terminal run event.', { runId: parsed.data.runId })
        return undefined
      }
      terminalRunId = parsed.data.runId
    }
    if (type === KERNEL_EVENT_APPROVAL_REQUESTED) {
      const approval = approvalRequestedPayloadSchema.safeParse(payload)
      if (!approval.success) throw new TypeError('approval.requested payload is invalid')
      approvalId = approval.data.approvalId
    }

    const event: KernelEventFrame = {
      kind: 'event',
      seq: this.lastSeq + 1,
      type,
      payload,
      ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
      ...(routing.runId ? { runId: routing.runId } : {})
    }
    const encoded = encodeFrame(event)
    if (terminalRunId) this.recordTerminalRun(terminalRunId, routing.sessionId)
    this.lastSeq = event.seq
    this.replay.push(event)
    if (this.replay.length > this.replayCapacity) this.replay.shift()
    if (approvalId) this.pendingApprovals.set(approvalId, event)

    const controller = this.controller
    if (controller && controller.liveEventsEnabled && this.isCurrentController(controller)) {
      this.sendEncoded(controller, encoded)
    }
    return event
  }

  private recordTerminalRun(runId: string, sessionId: string | undefined): void {
    this.terminalRuns.add(runId)
    if (this.terminalRuns.size > this.replayCapacity) {
      const oldestRunId = this.terminalRuns.values().next().value
      if (oldestRunId !== undefined) this.terminalRuns.delete(oldestRunId)
    }
    // Kernel-generated run ids are unique, so retaining the recent replay-sized window is
    // sufficient to suppress duplicate completion paths without keeping every historical id.
    const activeRun = sessionId ? this.activeRuns.get(sessionId) : undefined
    if (sessionId && activeRun?.phase === 'running' && activeRun.runId === runId) {
      this.activeRuns.delete(sessionId)
    }
    for (const [approvalId, event] of this.pendingApprovals) {
      if (event.runId === runId) this.pendingApprovals.delete(approvalId)
    }
  }

  requestHost(
    capability: string,
    params: JsonValue,
    context: KernelHostRequestContext = {}
  ): Promise<JsonValue> {
    const controller = this.controller
    if (
      (controller && !controller.hostCapabilities.has(capability)) ||
      (!controller && this.disconnectPolicy === 'fail-pending')
    ) {
      return Promise.reject(
        makeProtocolError(
          'CAPABILITY_UNAVAILABLE',
          'The requested host capability is not registered.'
        )
      )
    }

    const id = `host-${this.kernelInstanceId}-${++this.hostRequestCounter}`
    const frame: HostRequestFrame = { kind: 'host.request', id, capability, params, ...context }
    const generation = controller?.generation
    if (controller && (generation === undefined || generation !== this.controllerGeneration)) {
      return Promise.reject(
        makeProtocolError('STALE_GENERATION', 'The host controller generation is inactive.')
      )
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const pending: PendingHostRequest = { frame, resolve, reject }
      if (controller && generation !== undefined) {
        pending.connection = controller
        pending.generation = generation
      }
      this.pendingHostRequests.set(id, pending)
      if (!controller) return
      try {
        if (this.sendEncoded(controller, encodeFrame(frame))) return
        this.pendingHostRequests.delete(id)
        reject(makeProtocolError('INTERNAL', 'Host request could not be sent.'))
      } catch {
        this.pendingHostRequests.delete(id)
        reject(makeProtocolError('INTERNAL', 'Host request could not be encoded.'))
      }
    })
  }

  async expireDisconnectedState(): Promise<boolean> {
    const controller = this.controller
    if (controller && this.isCurrentController(controller)) return false

    const activeRuns = [...this.activeRuns]
    for (const [, activeRun] of activeRuns) {
      if (activeRun.phase === 'accepting') this.expiredPendingPrompts.add(activeRun.token)
      else this.expiringRunIds.add(activeRun.runId)
    }

    const context: KernelCallContext = {
      controllerGeneration: this.controllerGeneration,
      connectionId: 'kernel-lifecycle',
      trusted: true
    }
    const approvals = [...this.pendingApprovals]
    const respondToApproval = this.handlers['approval.respond']
    await Promise.all(
      approvals.map(async ([approvalId, event]) => {
        if (!respondToApproval) return
        const params = {
          approvalId,
          decision: 'denied',
          reason: 'client did not return'
        }
        const request: KernelRequestFrame = {
          kind: 'request',
          id: `lifecycle-deny-${approvalId}`,
          method: 'approval.respond',
          params,
          generation: this.controllerGeneration,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.runId ? { runId: event.runId } : {})
        }
        try {
          const result = await respondToApproval(params, context, request)
          if (!kernelMethodResultSchemas['approval.respond'].safeParse(result).success) {
            throw new TypeError('Grace expiry approval handler returned an invalid result')
          }
          this.pendingApprovals.delete(approvalId)
        } catch {
          this.log.error?.('Grace expiry could not deliver an approval denial.', {
            approvalId
          })
        }
      })
    )

    await Promise.all(
      activeRuns.map(async ([sessionId, activeRun]) => {
        if (activeRun.phase === 'accepting') {
          await this.abortRunForGrace(sessionId, undefined, context)
          await activeRun.settled
          return
        }
        const status = await this.abortRunForGrace(sessionId, activeRun.runId, context)
        this.completeRunAfterExpiry(sessionId, activeRun.runId, status)
      })
    )
    this.rejectAllPendingHostRequests()
    return true
  }

  private processLine(state: ConnectionState, line: string): void {
    if (state.closed) return
    const parsed = parseFrame(line)
    if (!('kind' in parsed)) {
      this.sendError(state, '__protocol__', parsed)
      return
    }

    switch (parsed.kind) {
      case 'request':
        void this.handleRequest(state, parsed).catch(() => {
          this.log.error?.('Kernel protocol failed to process a frame.', {
            connectionId: state.id
          })
        })
        return
      case 'host.response':
        this.handleHostResponse(state, parsed)
        return
      case 'response':
        this.log.warn?.('Ignored response with an unknown id.', {
          connectionId: state.id
        })
        return
      case 'host.request':
      case 'event':
        this.log.warn?.('Ignored a frame sent in the wrong direction.', {
          connectionId: state.id,
          frameKind: parsed.kind
        })
    }
  }

  private async handleRequest(state: ConnectionState, request: KernelRequestFrame): Promise<void> {
    if (state.requestIds.has(request.id)) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('DUPLICATE_REQUEST', 'Request id was already used on this connection.')
      )
      return
    }
    state.requestIds.add(request.id)

    if (request.method === 'kernel.hello') {
      this.handleHello(state, request)
      return
    }
    if (!state.negotiated) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('NOT_NEGOTIATED', 'kernel.hello must succeed before business requests.')
      )
      return
    }
    if (!this.isCurrentController(state) || request.generation !== this.controllerGeneration) {
      this.sendError(
        state,
        request.id,
        makeProtocolError(
          'STALE_GENERATION',
          'Request belongs to an inactive controller generation.'
        )
      )
      return
    }
    if (!businessMethods.has(request.method)) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('UNKNOWN_METHOD', 'The requested kernel method is unknown.')
      )
      return
    }

    const method = request.method as KernelBusinessMethod
    const handler = this.handlers[method]
    if (!handler) {
      this.sendError(
        state,
        request.id,
        makeProtocolError(
          'CAPABILITY_UNAVAILABLE',
          'The requested kernel capability is unavailable.'
        )
      )
      return
    }
    if (method === 'events.subscribe') {
      this.handleSubscribe(state, request)
      return
    }
    if (method === 'session.prompt') {
      await this.handlePrompt(state, request, handler)
      return
    }

    try {
      const result = await handler(request.params, this.contextFor(state), request)
      const parsedResult = kernelMethodResultSchemas[method].safeParse(result)
      if (!parsedResult.success) {
        const paths = parsedResult.error.issues
          .slice(0, 5)
          .map((issue) => issue.path.join('.') || '<root>')
        throw new TypeError(`Kernel method returned an invalid result at: ${paths.join(', ')}`)
      }
      if (method === 'approval.respond') {
        const approvalId = (request.params as { approvalId: string }).approvalId
        this.pendingApprovals.delete(approvalId)
      }
      this.sendSuccess(state, request.id, parsedResult.data as JsonValue)
    } catch (error) {
      this.handleHandlerFailure(state, request, error)
    }
  }

  private handleHello(state: ConnectionState, request: KernelRequestFrame): void {
    const params = request.params as {
      protocol: { major: number; minor: number }
      hostCapabilities?: string[]
      takeover?: boolean
    }
    if (params.protocol.major !== PHI_KERNEL_PROTOCOL_VERSION.major) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('VERSION_UNSUPPORTED', 'Kernel protocol major version is unsupported.', {
          peer: params.protocol,
          kernel: PHI_KERNEL_PROTOCOL_VERSION
        })
      )
      return
    }

    const previous = this.controller
    const previousGeneration = previous?.generation
    if (previous && previous !== state && (!params.takeover || !state.trusted)) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('NOT_CONTROLLER', 'Another connection controls this kernel instance.')
      )
      return
    }

    this.controllerGeneration += 1
    const awaitingReplay = state.negotiated && !state.liveEventsEnabled
    state.negotiated = true
    state.generation = this.controllerGeneration
    state.hostCapabilities = new Set(params.hostCapabilities ?? [])
    state.liveEventsEnabled =
      this.disconnectPolicy === 'fail-pending' || (!awaitingReplay && params.takeover !== true)
    if (!awaitingReplay) {
      state.approvalIdsToReannounce =
        this.disconnectPolicy === 'wait-for-reconnect'
          ? new Set(this.pendingApprovals.keys())
          : new Set()
    }
    this.controller = state
    if (previous) {
      if (this.disconnectPolicy === 'fail-pending') {
        this.rejectPendingHostRequests(previous, 'STALE_GENERATION')
      } else {
        this.detachPendingHostRequests(previous)
      }
      if (previousGeneration !== undefined) {
        this.notifyControllerGenerationDetached(previousGeneration)
      }
    }

    const capabilities = KERNEL_V1_METHODS.filter(
      (method): method is KernelBusinessMethod =>
        method !== 'kernel.hello' && typeof this.handlers[method] === 'function'
    )
    this.sendSuccess(state, request.id, {
      protocol: {
        major: PHI_KERNEL_PROTOCOL_VERSION.major,
        minor: Math.min(params.protocol.minor, PHI_KERNEL_PROTOCOL_VERSION.minor)
      },
      kernel: { version: this.options.kernelVersion, ompVersion: this.options.ompVersion },
      kernelInstanceId: this.kernelInstanceId,
      controllerGeneration: this.controllerGeneration,
      capabilities,
      lastSeq: this.lastSeq
    })
    if (this.disconnectPolicy === 'wait-for-reconnect') {
      this.resumePendingHostRequests(state)
    }
    this.notifyControllerGenerationAttached(this.controllerGeneration)
  }

  private handleSubscribe(state: ConnectionState, request: KernelRequestFrame): void {
    const { afterSeq } = request.params as { afterSeq: number }
    const oldestSeq = this.replay[0]?.seq ?? this.lastSeq + 1
    if (afterSeq < oldestSeq - 1) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('REPLAY_GAP', 'Requested events are no longer available.', { oldestSeq })
      )
      this.enableLiveEventsAfterReplay(state)
      return
    }
    if (afterSeq > this.lastSeq) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('INVALID_PARAMS', 'afterSeq is newer than the kernel event sequence.')
      )
      return
    }

    const lastSeq = this.lastSeq
    this.sendSuccess(state, request.id, { subscribed: true, lastSeq })
    for (const event of this.replay) {
      if (event.seq > afterSeq && event.seq <= lastSeq) {
        this.sendEncoded(state, encodeFrame(event))
      }
    }
    this.enableLiveEventsAfterReplay(state)
  }

  private async handlePrompt(
    state: ConnectionState,
    request: KernelRequestFrame,
    handler: KernelMethodHandler
  ): Promise<void> {
    const sessionId = request.sessionId
    if (!sessionId) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('INVALID_PARAMS', 'session.prompt requires a sessionId.')
      )
      return
    }
    if (this.activeRuns.has(sessionId)) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('SESSION_BUSY', 'The session already has an active run.')
      )
      return
    }

    let settlePendingRun!: () => void
    const settled = new Promise<void>((resolve) => {
      settlePendingRun = resolve
    })
    const pendingRun: ActiveRunState = {
      phase: 'accepting',
      token: ++this.promptCounter,
      settled,
      settle: settlePendingRun
    }
    this.activeRuns.set(sessionId, pendingRun)
    try {
      const result = await handler(request.params, this.contextFor(state), request)
      if (!this.isSessionPromptRun(result)) {
        throw makeProtocolError('INTERNAL', 'session.prompt handler returned an invalid run.')
      }
      if (this.expiredPendingPrompts.delete(pendingRun.token)) {
        if (this.activeRuns.get(sessionId) === pendingRun) this.activeRuns.delete(sessionId)
        void Promise.resolve(result.completion).catch(() => undefined)
        const status = await this.abortRunForGrace(sessionId, result.runId)
        this.completeRun(sessionId, result.runId, status)
        return
      }
      if (
        this.terminalRuns.has(result.runId) ||
        [...this.activeRuns.values()].some(
          (activeRun) => activeRun.phase === 'running' && activeRun.runId === result.runId
        )
      ) {
        throw makeProtocolError('INTERNAL', 'session.prompt returned a completed run id.')
      }

      this.activeRuns.set(sessionId, { phase: 'running', runId: result.runId })
      this.sendSuccess(state, request.id, { accepted: true, runId: result.runId })
      void Promise.resolve(result.completion).then(
        (completion) => {
          const status = typeof completion === 'string' ? completion : completion.status
          const detail = typeof completion === 'string' ? undefined : completion.detail
          this.completeRun(sessionId, result.runId, status, detail)
        },
        () => {
          this.log.error?.('Accepted session run failed.', {
            sessionId,
            runId: result.runId
          })
          this.completeRun(sessionId, result.runId, 'failed')
        }
      )
    } catch (error) {
      this.expiredPendingPrompts.delete(pendingRun.token)
      if (this.activeRuns.get(sessionId) === pendingRun) this.activeRuns.delete(sessionId)
      this.handleHandlerFailure(state, request, error)
    } finally {
      pendingRun.settle()
    }
  }

  private completeRun(
    sessionId: string,
    runId: string,
    status: RunCompletionStatus,
    detail?: string
  ): void {
    if (this.expiringRunIds.has(runId)) return
    const payload = { runId, status, ...(detail ? { detail } : {}) }
    if (!runCompletedPayloadSchema.safeParse(payload).success) {
      this.log.error?.('Ignored invalid session run completion.', { sessionId, runId })
      status = 'unknown'
    }
    this.emitEvent('run.completed', status === 'unknown' ? { runId, status } : payload, {
      sessionId,
      runId
    })
  }

  private completeRunAfterExpiry(
    sessionId: string,
    runId: string,
    status: RunCompletionStatus
  ): void {
    this.expiringRunIds.delete(runId)
    this.completeRun(sessionId, runId, status)
  }

  private isSessionPromptRun(value: unknown): value is SessionPromptRun {
    if (value === null || typeof value !== 'object') return false
    const candidate = value as Partial<SessionPromptRun>
    return (
      typeof candidate.runId === 'string' &&
      candidate.runId.length > 0 &&
      candidate.completion !== null &&
      typeof candidate.completion === 'object' &&
      typeof candidate.completion.then === 'function'
    )
  }

  private handleHandlerFailure(
    state: ConnectionState,
    request: KernelRequestFrame,
    error: unknown
  ): void {
    const normalized = normalizeHandlerError(error)
    if (normalized) {
      this.sendError(state, request.id, normalized)
      return
    }
    this.log.error?.('Kernel method handler failed.', {
      connectionId: state.id,
      method: request.method,
      requestId: request.id,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1024)
    })
    this.sendError(
      state,
      request.id,
      makeProtocolError('INTERNAL', 'Kernel method failed internally.')
    )
  }

  private handleHostResponse(state: ConnectionState, response: HostResponseFrame): void {
    const pending = this.pendingHostRequests.get(response.id)
    if (
      !pending ||
      pending.connection !== state ||
      pending.generation !== this.controllerGeneration ||
      !this.isCurrentController(state)
    ) {
      this.log.warn?.('Ignored host response with an unknown id.', {
        connectionId: state.id
      })
      return
    }
    this.pendingHostRequests.delete(response.id)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(response.error)
  }

  private closeConnection(state: ConnectionState): void {
    if (state.closed) return
    state.closed = true
    this.connections.delete(state.id)
    if (this.disconnectPolicy === 'fail-pending') this.rejectPendingHostRequests(state)
    else this.detachPendingHostRequests(state)
    if (this.controller === state) {
      this.controller = undefined
      if (state.generation !== undefined) {
        this.notifyControllerGenerationDetached(state.generation)
      }
    }
  }

  private notifyControllerGenerationDetached(generation: number): void {
    try {
      this.options.controllerLifecycle?.onControllerDetached?.(generation)
    } catch {
      this.log.error?.('Controller lifecycle detach observer failed.', { generation })
    }
    try {
      void Promise.resolve(this.handlers.onControllerDetached?.(generation)).catch(() => {
        this.log.error?.('Controller detach handler failed.', { generation })
      })
    } catch {
      this.log.error?.('Controller detach handler failed.', { generation })
    }
  }

  private notifyControllerGenerationAttached(generation: number): void {
    try {
      this.options.controllerLifecycle?.onControllerAttached?.(generation)
    } catch {
      this.log.error?.('Controller lifecycle attach observer failed.', { generation })
    }
  }

  private rejectPendingHostRequests(
    state: ConnectionState,
    code: 'CAPABILITY_UNAVAILABLE' | 'STALE_GENERATION' = 'CAPABILITY_UNAVAILABLE'
  ): void {
    for (const [id, pending] of this.pendingHostRequests) {
      if (pending.connection !== state) continue
      this.pendingHostRequests.delete(id)
      pending.reject(
        makeProtocolError(
          code,
          code === 'STALE_GENERATION'
            ? 'Host request belongs to an inactive controller generation.'
            : 'Host connection was detached.'
        )
      )
    }
  }

  private rejectAllPendingHostRequests(): void {
    for (const [id, pending] of this.pendingHostRequests) {
      this.pendingHostRequests.delete(id)
      pending.reject(
        makeProtocolError('CAPABILITY_UNAVAILABLE', 'Host grace period expired without a client.')
      )
    }
  }

  private detachPendingHostRequests(state: ConnectionState): void {
    for (const pending of this.pendingHostRequests.values()) {
      if (pending.connection !== state) continue
      pending.connection = undefined
      pending.generation = undefined
    }
  }

  private resumePendingHostRequests(state: ConnectionState): void {
    const generation = state.generation
    if (generation === undefined) return
    for (const [id, pending] of this.pendingHostRequests) {
      if (pending.connection) continue
      if (!state.hostCapabilities.has(pending.frame.capability)) {
        this.pendingHostRequests.delete(id)
        pending.reject(
          makeProtocolError(
            'CAPABILITY_UNAVAILABLE',
            'The reconnected host did not register the requested capability.'
          )
        )
        continue
      }
      pending.connection = state
      pending.generation = generation
      if (!this.sendEncoded(state, encodeFrame(pending.frame))) {
        pending.connection = undefined
        pending.generation = undefined
      }
    }
  }

  private enableLiveEventsAfterReplay(state: ConnectionState): void {
    state.liveEventsEnabled = true
    if (state.approvalIdsToReannounce.size === 0) return
    const approvalIds = state.approvalIdsToReannounce
    state.approvalIdsToReannounce = new Set()
    this.reannouncePendingApprovals(approvalIds)
  }

  private async abortRunForGrace(
    sessionId: string,
    runId?: string,
    context: KernelCallContext = {
      controllerGeneration: this.controllerGeneration,
      connectionId: 'kernel-lifecycle',
      trusted: true
    }
  ): Promise<RunCompletionStatus> {
    const abort = this.handlers['session.abort']
    if (!abort) return 'unknown'
    const params = {}
    const request: KernelRequestFrame = {
      kind: 'request',
      id: `lifecycle-abort-${runId ?? sessionId}`,
      method: 'session.abort',
      params,
      generation: this.controllerGeneration,
      sessionId,
      ...(runId ? { runId } : {})
    }
    try {
      const result = await abort(params, context, request)
      if (!kernelMethodResultSchemas['session.abort'].safeParse(result).success) {
        throw new TypeError('Grace expiry abort handler returned an invalid result')
      }
      return 'cancelled'
    } catch {
      this.log.error?.('Grace expiry could not prove an active run stopped.', {
        sessionId,
        ...(runId ? { runId } : {})
      })
      return 'unknown'
    }
  }

  private reannouncePendingApprovals(approvalIds: ReadonlySet<string>): void {
    for (const approvalId of approvalIds) {
      const event = this.pendingApprovals.get(approvalId)
      if (!event) continue
      this.emitEvent(event.type, event.payload, {
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.runId ? { runId: event.runId } : {})
      })
    }
  }

  private isCurrentController(state: ConnectionState): boolean {
    return (
      this.controller === state && state.generation === this.controllerGeneration && !state.closed
    )
  }

  private contextFor(state: ConnectionState): KernelCallContext {
    return {
      controllerGeneration: this.controllerGeneration,
      connectionId: state.id,
      trusted: state.trusted
    }
  }

  private sendSuccess(state: ConnectionState, id: string, result: JsonValue): void {
    const response: KernelResponseFrame = { kind: 'response', id, ok: true, result }
    try {
      this.sendEncoded(state, encodeFrame(response))
    } catch {
      this.sendError(
        state,
        id,
        makeProtocolError('INTERNAL', 'Kernel produced an invalid response.')
      )
    }
  }

  private sendError(state: ConnectionState, id: string, error: ProtocolError): void {
    const response: KernelResponseFrame = { kind: 'response', id, ok: false, error }
    try {
      this.sendEncoded(state, encodeFrame(response))
    } catch {
      const fallback: KernelResponseFrame = {
        kind: 'response',
        id,
        ok: false,
        error: { code: 'INTERNAL', message: 'Kernel could not encode an error response.' }
      }
      this.sendEncoded(state, encodeFrame(fallback))
    }
  }

  private sendEncoded(state: ConnectionState, line: string): boolean {
    if (state.closed) return false
    try {
      state.transport.send(line)
      return true
    } catch {
      this.log.error?.('Kernel protocol transport send failed.', { connectionId: state.id })
      return false
    }
  }
}
