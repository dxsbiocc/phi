import {
  KERNEL_HOST_CAPABILITY_REGISTRY,
  type HostProgressFrame,
  type HostRequestFrame,
  type HostResponseFrame,
  type InteractionCancelledPayload,
  type JsonValue,
  type ProtocolError,
  type ProtocolErrorCode
} from '../../shared/kernel-protocol'
import { makeProtocolError } from '../protocol/errors'
import type { KernelHostRequestContext, KernelProtocolLogger } from '../protocol/types'
import type { KernelHostProgressHandler } from '../protocol/types'

type Timer = ReturnType<typeof setTimeout>

export interface HostController<Connection> {
  readonly connection: Connection
  readonly generation: number
  readonly capabilities: ReadonlySet<string>
}

interface PendingHostRequest<Connection> {
  readonly frame: HostRequestFrame
  readonly capability: keyof typeof KERNEL_HOST_CAPABILITY_REGISTRY
  readonly sessionId?: string
  readonly runId?: string
  readonly agentRunId?: string
  connection?: Connection
  generation: number
  timer?: Timer
  onProgress?: KernelHostProgressHandler
  resolve(value: JsonValue): void
  reject(error: ProtocolError): void
}

type PreparedHostRequest = {
  readonly capability: keyof typeof KERNEL_HOST_CAPABILITY_REGISTRY
  readonly params: JsonValue
  readonly interaction: 'user' | 'service'
  readonly timeoutMs?: number
}

type HostRequestDelivery<Connection> = {
  readonly controller?: HostController<Connection>
  readonly onProgress?: KernelHostProgressHandler
}

type HostRequestManagerOptions<Connection> = {
  readonly kernelInstanceId: string
  readonly replayCapacity: number
  readonly disconnectPolicy: 'fail-pending' | 'wait-for-reconnect'
  readonly log: KernelProtocolLogger
  readonly timeoutMs?: number
  send(connection: Connection, frame: HostRequestFrame): boolean
  isCurrent(connection: Connection, generation: number): boolean
  onCancelled(payload: InteractionCancelledPayload): void
}

class BoundedIds {
  private readonly values = new Set<string>()

  constructor(private readonly capacity: number) {}

  add(id: string): void {
    this.values.delete(id)
    this.values.add(id)
    if (this.values.size <= this.capacity) return
    const oldest = this.values.values().next().value
    if (oldest !== undefined) this.values.delete(oldest)
  }

  has(id: string): boolean {
    return this.values.has(id)
  }
}

function issuePaths(error: { issues: ReadonlyArray<{ path: PropertyKey[] }> }): string[] {
  return error.issues.slice(0, 5).map((issue) => issue.path.join('.') || '<root>')
}

export class KernelHostRequestManager<Connection> {
  private readonly pending = new Map<string, PendingHostRequest<Connection>>()
  private readonly cancelledIds: BoundedIds
  private readonly answeredIds: BoundedIds
  private readonly diagnosedResponseIds: BoundedIds
  private readonly diagnosedProgressIds: BoundedIds
  private requestCounter = 0

  constructor(private readonly options: HostRequestManagerOptions<Connection>) {
    this.cancelledIds = new BoundedIds(options.replayCapacity)
    this.answeredIds = new BoundedIds(options.replayCapacity)
    this.diagnosedResponseIds = new BoundedIds(options.replayCapacity)
    this.diagnosedProgressIds = new BoundedIds(options.replayCapacity)
  }

  request(
    capability: string,
    params: JsonValue,
    context: KernelHostRequestContext,
    controllerGeneration: number,
    delivery: HostRequestDelivery<Connection> = {}
  ): Promise<JsonValue> {
    const prepared = this.prepareRequest(capability, params, context)
    if ('code' in prepared) return Promise.reject(prepared)
    const controllerError = this.controllerError(capability, delivery.controller)
    if (controllerError) return Promise.reject(controllerError)
    return this.enqueue(
      prepared,
      context,
      controllerGeneration,
      delivery.controller,
      delivery.onProgress
    )
  }

  private prepareRequest(
    capability: string,
    params: JsonValue,
    context: KernelHostRequestContext
  ): PreparedHostRequest | ProtocolError {
    if (!Object.hasOwn(KERNEL_HOST_CAPABILITY_REGISTRY, capability)) {
      this.options.log.error?.('Kernel worker requested an unknown host capability.', {
        capability
      })
      return makeProtocolError('INTERNAL', 'Kernel worker requested an unknown host capability.')
    }
    const name = capability as keyof typeof KERNEL_HOST_CAPABILITY_REGISTRY
    const definition = KERNEL_HOST_CAPABILITY_REGISTRY[name]
    const parsedParams = definition.params.safeParse(params)
    if (!parsedParams.success) {
      this.options.log.error?.('Kernel host request parameters are invalid.', {
        capability,
        paths: issuePaths(parsedParams.error)
      })
      return makeProtocolError('INVALID_PARAMS', 'Host request parameters are invalid.')
    }
    if (definition.runScoped === true && (!context.sessionId || !context.runId)) {
      const missing = [
        ...(context.sessionId ? [] : ['sessionId']),
        ...(context.runId ? [] : ['runId'])
      ]
      this.options.log.error?.('Run-scoped host request omitted interaction binding.', {
        capability,
        missing
      })
      return makeProtocolError('INTERNAL', 'Run-scoped host request omitted interaction binding.')
    }
    return {
      capability: name,
      params: parsedParams.data as JsonValue,
      interaction: definition.interaction,
      ...('timeoutMs' in definition ? { timeoutMs: definition.timeoutMs } : {})
    }
  }

  private controllerError(
    capability: string,
    controller: HostController<Connection> | undefined
  ): ProtocolError | undefined {
    if (
      (controller && !controller.capabilities.has(capability)) ||
      (!controller && this.options.disconnectPolicy === 'fail-pending')
    ) {
      return makeProtocolError(
        'CAPABILITY_UNAVAILABLE',
        'The requested host capability is not registered.'
      )
    }
    if (controller && !this.options.isCurrent(controller.connection, controller.generation)) {
      return makeProtocolError('STALE_GENERATION', 'The host controller generation is inactive.')
    }
    return undefined
  }

  private enqueue(
    prepared: PreparedHostRequest,
    context: KernelHostRequestContext,
    controllerGeneration: number,
    controller: HostController<Connection> | undefined,
    onProgress: KernelHostProgressHandler | undefined
  ): Promise<JsonValue> {
    const id = `host-${this.options.kernelInstanceId}-${++this.requestCounter}`
    const frame: HostRequestFrame = {
      kind: 'host.request',
      id,
      capability: prepared.capability,
      params: prepared.params,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
      ...(context.agentRunId ? { agentRunId: context.agentRunId } : {})
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const pending: PendingHostRequest<Connection> = {
        frame,
        capability: prepared.capability,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context.runId ? { runId: context.runId } : {}),
        ...(context.agentRunId ? { agentRunId: context.agentRunId } : {}),
        generation: controller?.generation ?? controllerGeneration,
        ...(onProgress ? { onProgress } : {}),
        resolve,
        reject
      }
      if (controller) {
        pending.connection = controller.connection
      }
      this.pending.set(id, pending)
      if (prepared.interaction === 'service') {
        const timeoutMs = this.options.timeoutMs ?? prepared.timeoutMs
        if (timeoutMs === undefined) {
          this.remove(id, pending)
          reject(makeProtocolError('INTERNAL', 'Service capability omitted its timeout.'))
          return
        }
        pending.timer = setTimeout(() => {
          if (this.pending.get(id) !== pending) return
          this.cancel(id, pending, 'host capability timed out')
        }, timeoutMs)
        pending.timer.unref?.()
      }
      if (!controller) return
      if (this.options.send(controller.connection, frame)) return
      this.remove(id, pending)
      reject(makeProtocolError('INTERNAL', 'Host request could not be sent.'))
    })
  }

  handleResponse(
    connection: Connection,
    response: HostResponseFrame,
    currentGeneration: number
  ): void {
    const pending = this.pending.get(response.id)
    if (
      !pending ||
      pending.connection !== connection ||
      pending.generation !== currentGeneration ||
      !this.options.isCurrent(connection, currentGeneration)
    ) {
      this.diagnoseIgnoredResponse(response.id)
      return
    }

    this.remove(response.id, pending)
    this.answeredIds.add(response.id)
    if (!response.ok) {
      pending.reject(response.error)
      return
    }
    const definition = KERNEL_HOST_CAPABILITY_REGISTRY[pending.capability]
    const parsedResult = definition.result.safeParse(response.result)
    if (!parsedResult.success) {
      this.options.log.error?.('Host capability returned an invalid result.', {
        capability: pending.capability,
        paths: issuePaths(parsedResult.error)
      })
      pending.reject(makeProtocolError('INVALID_PARAMS', 'Host capability result is invalid.'))
      return
    }
    pending.resolve(parsedResult.data as JsonValue)
  }

  handleProgress(
    connection: Connection,
    frame: HostProgressFrame,
    currentGeneration: number
  ): void {
    const pending = this.pending.get(frame.id)
    if (!pending) {
      this.diagnoseIgnoredProgress(frame.id, 'inactive')
      return
    }
    const definition = KERNEL_HOST_CAPABILITY_REGISTRY[pending.capability]
    if (!('progress' in definition) || definition.progress !== true) {
      this.diagnoseIgnoredProgress(frame.id, 'capability_not_progressive')
      return
    }
    if (
      pending.connection !== connection ||
      pending.generation !== currentGeneration ||
      !this.options.isCurrent(connection, currentGeneration)
    ) {
      this.diagnoseIgnoredProgress(frame.id, 'inactive_controller')
      return
    }
    try {
      pending.onProgress?.(frame.progress)
    } catch {
      this.diagnoseIgnoredProgress(frame.id, 'observer_failed')
    }
  }

  rejectForConnection(
    connection: Connection,
    code: Extract<
      ProtocolErrorCode,
      'CAPABILITY_UNAVAILABLE' | 'STALE_GENERATION'
    > = 'CAPABILITY_UNAVAILABLE'
  ): void {
    for (const [id, pending] of this.pending) {
      if (pending.connection !== connection) continue
      this.cancel(
        id,
        pending,
        code === 'STALE_GENERATION' ? 'controller generation replaced' : 'host connection detached',
        code
      )
    }
  }

  rejectAll(reason: string): void {
    for (const [id, pending] of [...this.pending]) {
      this.cancel(id, pending, reason, 'CAPABILITY_UNAVAILABLE')
    }
  }

  detach(connection: Connection): void {
    for (const pending of this.pending.values()) {
      if (pending.connection !== connection) continue
      pending.connection = undefined
    }
  }

  resume(controller: HostController<Connection>): void {
    for (const [id, pending] of this.pending) {
      if (pending.connection) continue
      if (!controller.capabilities.has(pending.frame.capability)) {
        this.cancel(id, pending, 'reconnected host omitted capability', 'CAPABILITY_UNAVAILABLE')
        continue
      }
      pending.connection = controller.connection
      pending.generation = controller.generation
      if (!this.options.send(controller.connection, pending.frame)) {
        pending.connection = undefined
      }
    }
  }

  cancelRun(sessionId: string, runId: string, reason: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.sessionId !== sessionId || pending.runId !== runId) continue
      const definition = KERNEL_HOST_CAPABILITY_REGISTRY[pending.capability]
      if (definition.runScoped === false) continue
      this.cancel(id, pending, reason)
    }
  }

  cancelAgentRun(sessionId: string, agentRunId: string, reason: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.sessionId !== sessionId || pending.agentRunId !== agentRunId) continue
      const definition = KERNEL_HOST_CAPABILITY_REGISTRY[pending.capability]
      if (definition.runScoped === false) continue
      this.cancel(id, pending, reason)
    }
  }

  cancelSession(sessionId: string, reason: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.sessionId !== sessionId) continue
      const definition = KERNEL_HOST_CAPABILITY_REGISTRY[pending.capability]
      if (definition.runScoped === false) continue
      this.cancel(id, pending, reason)
    }
  }

  private cancel(
    id: string,
    pending: PendingHostRequest<Connection>,
    reason: string,
    code: Extract<
      ProtocolErrorCode,
      'CANCELLED' | 'CAPABILITY_UNAVAILABLE' | 'STALE_GENERATION'
    > = 'CANCELLED'
  ): void {
    this.remove(id, pending)
    this.cancelledIds.add(id)
    pending.reject(makeProtocolError(code, reason))
    if (!pending.sessionId) return
    this.options.onCancelled({
      kind: 'host',
      id,
      sessionId: pending.sessionId,
      ...(pending.runId ? { runId: pending.runId } : {}),
      reason
    })
  }

  private remove(id: string, pending: PendingHostRequest<Connection>): void {
    if (this.pending.get(id) === pending) this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
  }

  private diagnoseIgnoredResponse(id: string): void {
    if (this.diagnosedResponseIds.has(id)) return
    this.diagnosedResponseIds.add(id)
    const state = this.cancelledIds.has(id)
      ? 'cancelled'
      : this.answeredIds.has(id)
        ? 'answered'
        : 'unknown'
    this.options.log.warn?.('Ignored host response with an inactive id.', { state })
  }

  private diagnoseIgnoredProgress(id: string, reason: string): void {
    if (this.diagnosedProgressIds.has(id)) return
    this.diagnosedProgressIds.add(id)
    this.options.log.warn?.('Ignored host progress frame.', { reason })
  }
}
