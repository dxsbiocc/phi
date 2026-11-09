import {
  KERNEL_EVENT_APPROVAL_REQUESTED,
  KERNEL_EVENT_INTERACTION_CANCELLED,
  KERNEL_V1_METHODS,
  PHI_KERNEL_PROTOCOL_VERSION,
  approvalRequestedPayloadSchema,
  encodeFrame,
  interactionCancelledPayloadSchema,
  kernelMethodResultSchemas,
  parseFrame,
  runCompletedPayloadSchema,
  type HostResponseFrame,
  type JsonValue,
  type KernelEventFrame,
  type KernelRequestFrame,
  type KernelResponseFrame,
  type ProtocolError
} from '../../shared/kernel-protocol'
import { ProtocolEncodeError } from '../../shared/kernel-protocol/errors'
import {
  KernelApprovalTracker,
  approvalCancellationPayload,
  type PendingApproval
} from '../host/approval-tracker'
import { KernelHostRequestManager } from '../host/host-request-manager'
import { makeProtocolError, normalizeHandlerError, sanitizedRunFailureDetail } from './errors'
import { rejectsHostInternalFields } from './trusted-fields'
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

type EventMetadata = {
  duplicate: boolean
  terminalRunId?: string
  approvalId?: string
}

type ActiveRunState =
  | {
      readonly phase: 'accepting'
      readonly token: number
      readonly settled: Promise<void>
      settle(): void
    }
  | { readonly phase: 'running'; readonly runId: string }

type RoutedBusinessMethod = {
  readonly method: KernelBusinessMethod
  readonly handler: KernelMethodHandler
}

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
  private readonly hostRequests: KernelHostRequestManager<ConnectionState>
  private readonly approvals: KernelApprovalTracker
  private readonly expiredPendingPrompts = new Set<number>()
  private readonly expiringRunIds = new Set<string>()
  private controller?: ConnectionState
  private connectionCounter = 0
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
    if (
      options.hostRequestTimeoutMs !== undefined &&
      (!Number.isFinite(options.hostRequestTimeoutMs) || options.hostRequestTimeoutMs < 1)
    ) {
      throw new RangeError('hostRequestTimeoutMs must be a positive finite number')
    }
    this.approvals = new KernelApprovalTracker(this.replayCapacity)
    this.hostRequests = new KernelHostRequestManager<ConnectionState>({
      kernelInstanceId: this.kernelInstanceId,
      replayCapacity: this.replayCapacity,
      disconnectPolicy: this.disconnectPolicy,
      log: this.log,
      timeoutMs: options.hostRequestTimeoutMs,
      send: (connection, frame) => this.sendEncoded(connection, encodeFrame(frame)),
      isCurrent: (connection, generation) =>
        this.isCurrentController(connection) && generation === this.controllerGeneration,
      onCancelled: (payload) => {
        this.emitEvent(KERNEL_EVENT_INTERACTION_CANCELLED, payload, {
          sessionId: payload.sessionId,
          ...(payload.runId ? { runId: payload.runId } : {})
        })
      }
    })
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
    const { duplicate, terminalRunId, approvalId } = this.eventMetadata(type, payload)
    if (duplicate) return undefined

    // Cancelling run-scoped interactions can emit events of its own, so it must happen before
    // the terminal event claims the next sequence number.
    if (terminalRunId) this.recordTerminalRun(terminalRunId, routing.sessionId)
    const event: KernelEventFrame = {
      kind: 'event',
      seq: this.lastSeq + 1,
      type,
      payload,
      ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
      ...(routing.runId ? { runId: routing.runId } : {})
    }
    const encoded = encodeFrame(event)
    this.lastSeq = event.seq
    this.replay.push(event)
    if (this.replay.length > this.replayCapacity) this.replay.shift()
    if (approvalId) {
      this.approvals.add(
        approvalId,
        event,
        this.controller?.generation ?? this.controllerGeneration
      )
    }

    const controller = this.controller
    if (controller && controller.liveEventsEnabled && this.isCurrentController(controller)) {
      this.sendEncoded(controller, encoded)
    }
    return event
  }

  /** Child completion owns cancellation of interactions bound to that child id. */
  cancelAgentRunInteractions(sessionId: string, agentRunId: string, reason: string): void {
    this.hostRequests.cancelAgentRun(sessionId, agentRunId, reason)
    this.cancelApprovals(this.approvals.cancelAgentRun(sessionId, agentRunId), reason)
  }

  private eventMetadata(type: string, payload: JsonValue): EventMetadata {
    let terminalRunId: string | undefined
    let approvalId: string | undefined
    if (type === 'run.completed') {
      const parsed = runCompletedPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new TypeError('run.completed payload is invalid')
      }
      if (this.terminalRuns.has(parsed.data.runId)) {
        this.log.warn?.('Ignored duplicate terminal run event.', { runId: parsed.data.runId })
        return { duplicate: true }
      }
      terminalRunId = parsed.data.runId
    }
    if (type === KERNEL_EVENT_APPROVAL_REQUESTED) {
      const approval = approvalRequestedPayloadSchema.safeParse(payload)
      if (!approval.success) throw new TypeError('approval.requested payload is invalid')
      approvalId = approval.data.approvalId
    }
    if (
      type === KERNEL_EVENT_INTERACTION_CANCELLED &&
      !interactionCancelledPayloadSchema.safeParse(payload).success
    ) {
      throw new TypeError('interaction.cancelled payload is invalid')
    }
    return { duplicate: false, terminalRunId, approvalId }
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
    if (sessionId) this.cancelRunInteractions(sessionId, runId, 'run ended')
  }

  requestHost(
    capability: string,
    params: JsonValue,
    context: KernelHostRequestContext = {},
    onProgress?: (progress: JsonValue) => void
  ): Promise<JsonValue> {
    const controller = this.controller
    return this.hostRequests.request(capability, params, context, this.controllerGeneration, {
      ...(controller?.generation === undefined
        ? {}
        : {
            controller: {
              connection: controller,
              generation: controller.generation,
              capabilities: controller.hostCapabilities
            }
          }),
      ...(onProgress ? { onProgress } : {})
    })
  }

  hasActiveRuns(): boolean {
    return this.activeRuns.size > 0
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
    const approvals = this.approvals.cancelAll()
    this.cancelApprovals(approvals, 'client did not return')

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
    this.hostRequests.rejectAll('Host grace period expired without a client.')
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
      case 'host.progress':
        this.hostRequests.handleProgress(state, parsed, this.controllerGeneration)
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
    if (this.rejectControllerRequest(state, request)) return
    const route = this.routeBusinessMethod(state, request)
    if (!route) return
    const { method, handler } = route
    if (rejectsHostInternalFields(state.trusted, request, method)) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('INVALID_PARAMS', 'Host-internal request fields require a trusted entry.')
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

    const affectedRunId = this.affectedRunId(request)
    if (!this.reserveApprovalResponse(state, request, method)) return
    if (method === 'session.abort' && request.sessionId) {
      if (affectedRunId) this.cancelRunInteractions(request.sessionId, affectedRunId, 'run ended')
      else this.cancelSessionInteractions(request.sessionId, 'session aborted')
    }
    try {
      const result = await handler(request.params, this.contextFor(state), request)
      this.handleMethodSuccess(state, request, method, result)
    } catch (error) {
      this.handleHandlerFailure(state, request, error)
    }
  }

  private rejectControllerRequest(state: ConnectionState, request: KernelRequestFrame): boolean {
    if (this.controller && this.controller !== state) {
      this.sendError(
        state,
        request.id,
        request.generation === this.controllerGeneration
          ? makeProtocolError('NOT_CONTROLLER', 'The connection is not the active controller.')
          : makeProtocolError(
              'STALE_GENERATION',
              'Request belongs to an inactive controller generation.'
            )
      )
      return true
    }
    if (!state.negotiated) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('NOT_NEGOTIATED', 'kernel.hello must succeed before business requests.')
      )
      return true
    }
    if (request.generation !== this.controllerGeneration) {
      this.sendError(
        state,
        request.id,
        makeProtocolError(
          'STALE_GENERATION',
          'Request belongs to an inactive controller generation.'
        )
      )
      return true
    }
    if (!this.isCurrentController(state)) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('NOT_CONTROLLER', 'The connection is not the active controller.')
      )
      return true
    }
    return false
  }

  private routeBusinessMethod(
    state: ConnectionState,
    request: KernelRequestFrame
  ): RoutedBusinessMethod | undefined {
    if (!businessMethods.has(request.method)) {
      this.sendError(
        state,
        request.id,
        makeProtocolError('UNKNOWN_METHOD', 'The requested kernel method is unknown.')
      )
      return undefined
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
      return undefined
    }
    return { method, handler }
  }

  private affectedRunId(request: KernelRequestFrame): string | undefined {
    const activeRun = request.sessionId ? this.activeRuns.get(request.sessionId) : undefined
    return request.runId ?? (activeRun?.phase === 'running' ? activeRun.runId : undefined)
  }

  private reserveApprovalResponse(
    state: ConnectionState,
    request: KernelRequestFrame,
    method: KernelBusinessMethod
  ): boolean {
    if (method !== 'approval.respond') return true
    const approvalId = (request.params as { approvalId: string }).approvalId
    const reservation = this.approvals.reserveAnswer(approvalId, request.sessionId)
    if ('code' in reservation) {
      this.sendError(state, request.id, reservation)
      return false
    }
    return true
  }

  private handleMethodSuccess(
    state: ConnectionState,
    request: KernelRequestFrame,
    method: KernelBusinessMethod,
    result: JsonValue | SessionPromptRun
  ): void {
    const parsedResult = kernelMethodResultSchemas[method].safeParse(result)
    if (!parsedResult.success) {
      const paths = parsedResult.error.issues
        .slice(0, 5)
        .map((issue) => issue.path.join('.') || '<root>')
      throw new TypeError(`Kernel method returned an invalid result at: ${paths.join(', ')}`)
    }
    if (method === 'session.close' && request.sessionId) {
      this.cancelSessionInteractions(request.sessionId, 'session closed')
    }
    this.sendSuccess(state, request.id, parsedResult.data as JsonValue, method)
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
    if (this.controllerReplacementDenied(previous, state, params.takeover)) {
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
        this.disconnectPolicy === 'wait-for-reconnect' ? new Set(this.approvals.ids()) : new Set()
    }
    this.controller = state
    if (previous) {
      if (this.disconnectPolicy === 'fail-pending') {
        this.hostRequests.rejectForConnection(previous, 'STALE_GENERATION')
      } else {
        this.hostRequests.detach(previous)
      }
      if (previousGeneration !== undefined) {
        this.notifyControllerGenerationDetached(previousGeneration)
      }
    }

    const capabilities = KERNEL_V1_METHODS.filter(
      (method): method is KernelBusinessMethod =>
        method !== 'kernel.hello' && typeof this.handlers[method] === 'function'
    )
    this.sendSuccess(
      state,
      request.id,
      {
        protocol: {
          major: PHI_KERNEL_PROTOCOL_VERSION.major,
          minor: Math.min(params.protocol.minor, PHI_KERNEL_PROTOCOL_VERSION.minor)
        },
        kernel: { version: this.options.kernelVersion, ompVersion: this.options.ompVersion },
        kernelInstanceId: this.kernelInstanceId,
        controllerGeneration: this.controllerGeneration,
        capabilities,
        lastSeq: this.lastSeq,
        runtime: this.options.runtimeIdentity ?? { home: '', agentDir: '' }
      },
      'kernel.hello'
    )
    if (this.disconnectPolicy === 'wait-for-reconnect') {
      this.hostRequests.resume({
        connection: state,
        generation: this.controllerGeneration,
        capabilities: state.hostCapabilities
      })
    }
    this.notifyControllerGenerationAttached(this.controllerGeneration)
  }

  private controllerReplacementDenied(
    previous: ConnectionState | undefined,
    next: ConnectionState,
    takeover: boolean | undefined
  ): boolean {
    return previous !== undefined && previous !== next && (!takeover || !next.trusted)
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
    this.sendSuccess(state, request.id, { subscribed: true, lastSeq }, 'events.subscribe')
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
    if (await this.handleActivePromptConflict(state, request, sessionId)) return

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
      this.sendSuccess(state, request.id, { accepted: true, runId: result.runId }, 'session.prompt')
      void Promise.resolve(result.completion).then(
        (completion) => {
          const status = typeof completion === 'string' ? completion : completion.status
          const detail = typeof completion === 'string' ? undefined : completion.detail
          this.completeRun(sessionId, result.runId, status, detail)
        },
        (error) => {
          this.log.error?.('Accepted session run failed.', {
            sessionId,
            runId: result.runId
          })
          this.completeRun(sessionId, result.runId, 'failed', sanitizedRunFailureDetail(error))
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

  private async handleActivePromptConflict(
    state: ConnectionState,
    request: KernelRequestFrame,
    sessionId: string
  ): Promise<boolean> {
    if (!this.activeRuns.has(sessionId)) return false
    try {
      const conflict = await this.handlers.promptConflict?.(
        sessionId,
        request.params,
        this.contextFor(state),
        request
      )
      if (conflict) {
        this.sendError(
          state,
          request.id,
          makeProtocolError(
            'DUPLICATE_REQUEST',
            'The client run key was already accepted for this session.',
            conflict
          )
        )
        return true
      }
    } catch (error) {
      this.handleHandlerFailure(state, request, error)
      return true
    }
    this.sendError(
      state,
      request.id,
      makeProtocolError('SESSION_BUSY', 'The session already has an active run.')
    )
    return true
  }

  private completeRun(
    sessionId: string,
    runId: string,
    status: RunCompletionStatus,
    detail?: string
  ): void {
    if (this.expiringRunIds.has(runId)) return
    const metadata = this.handlers.runCompletionMetadata?.(sessionId) ?? {}
    const payload = { runId, status, ...(detail ? { detail } : {}), ...metadata }
    if (!runCompletedPayloadSchema.safeParse(payload).success) {
      this.log.error?.('Ignored invalid session run completion.', { sessionId, runId })
      status = 'unknown'
    }
    const emitted = this.emitEvent(
      'run.completed',
      status === 'unknown' ? { runId, status, ...metadata } : payload,
      {
        sessionId,
        runId
      }
    )
    if (emitted) {
      void Promise.resolve(this.handlers.onRunCompleted?.(sessionId, runId, status)).catch(() => {
        this.log.error?.('Run completion host side effect failed.', { sessionId, runId })
      })
    }
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
      // The wire carries fixed text for most codes, so keep the real cause where it can be read.
      const original = String((error as { message?: unknown }).message)
      if (normalized.code === 'INTERNAL') {
        this.log.error?.('Kernel method failed internally.', {
          connectionId: state.id,
          method: request.method,
          requestId: request.id,
          error: original.slice(0, 1024)
        })
      } else if (normalized.code === 'CAPABILITY_UNAVAILABLE') {
        const reason = (normalized.detail as { reason?: unknown } | undefined)?.reason
        this.log.error?.('Kernel method hit an unavailable capability.', {
          connectionId: state.id,
          method: request.method,
          requestId: request.id,
          error: original.slice(0, 1024),
          ...(typeof reason === 'string' ? { reason: reason.slice(0, 128) } : {})
        })
      }
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
    this.hostRequests.handleResponse(state, response, this.controllerGeneration)
  }

  private closeConnection(state: ConnectionState): void {
    if (state.closed) return
    state.closed = true
    this.connections.delete(state.id)
    if (this.disconnectPolicy === 'fail-pending') this.hostRequests.rejectForConnection(state)
    else this.hostRequests.detach(state)
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

  private enableLiveEventsAfterReplay(state: ConnectionState): void {
    state.liveEventsEnabled = true
    if (state.approvalIdsToReannounce.size === 0) return
    const approvalIds = state.approvalIdsToReannounce
    state.approvalIdsToReannounce = new Set()
    this.reannouncePendingApprovals(approvalIds)
  }

  private cancelRunInteractions(sessionId: string, runId: string, reason: string): void {
    this.hostRequests.cancelRun(sessionId, runId, reason)
    this.cancelApprovals(this.approvals.cancelRun(sessionId, runId), reason)
  }

  private cancelSessionInteractions(sessionId: string, reason: string): void {
    this.hostRequests.cancelSession(sessionId, reason)
    this.cancelApprovals(this.approvals.cancelSession(sessionId), reason)
  }

  private cancelApprovals(approvals: Array<[string, PendingApproval]>, reason: string): void {
    const handler = this.handlers['approval.respond']
    for (const [approvalId, pending] of approvals) {
      const payload = approvalCancellationPayload(approvalId, pending, reason)
      if (payload) {
        this.emitEvent(KERNEL_EVENT_INTERACTION_CANCELLED, payload, {
          sessionId: payload.sessionId,
          ...(payload.runId ? { runId: payload.runId } : {})
        })
      }
      if (!handler) {
        this.log.error?.('Cancelled approval could not be delivered to the worker.', { approvalId })
        continue
      }
      const request: KernelRequestFrame = {
        kind: 'request',
        id: `interaction-cancel-${approvalId}`,
        method: 'approval.respond',
        params: { approvalId, decision: 'denied', reason },
        generation: pending.generation,
        ...(pending.event.sessionId ? { sessionId: pending.event.sessionId } : {}),
        ...(pending.event.runId ? { runId: pending.event.runId } : {})
      }
      const context: KernelCallContext = {
        controllerGeneration: request.generation,
        connectionId: 'kernel-interaction',
        trusted: true
      }
      void Promise.resolve(handler(request.params, context, request))
        .then((result) => {
          if (!kernelMethodResultSchemas['approval.respond'].safeParse(result).success) {
            throw new TypeError('Approval cancellation handler returned an invalid result')
          }
        })
        .catch(() => {
          this.log.error?.('Cancelled approval could not be delivered to the worker.', {
            approvalId
          })
        })
    }
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
      const pending = this.approvals.get(approvalId)
      if (!pending) continue
      const { event } = pending
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
      trusted: state.trusted,
      hostCapabilities: state.hostCapabilities
    }
  }

  private sendSuccess(
    state: ConnectionState,
    id: string,
    result: JsonValue,
    method?: string
  ): void {
    const response: KernelResponseFrame = { kind: 'response', id, ok: true, result }
    try {
      this.sendEncoded(state, encodeFrame(response))
    } catch (error) {
      const encodeError = error instanceof ProtocolEncodeError ? error : undefined
      const message =
        encodeError?.message ?? (error instanceof Error ? error.message : String(error))
      this.log.error?.('Kernel response could not be encoded.', {
        ...(method ? { method } : {}),
        code: encodeError?.code ?? 'UNKNOWN',
        message: message.slice(0, 1024)
      })
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
