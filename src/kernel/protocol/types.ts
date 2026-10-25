import type {
  JsonValue,
  KernelRequestFrame,
  KernelV1Method,
  RunCompletedPayload
} from '../../shared/kernel-protocol'

export interface FrameTransport {
  send(line: string): void
  onLine(callback: (line: string) => void): void
  onClose(callback: () => void): void
}

/**
 * This context is constructed by a trusted entry. Future member/execution identity belongs
 * here, never in a client-supplied request frame.
 */
export interface KernelCallContext {
  controllerGeneration: number
  connectionId: string
  trusted: boolean
}

export type RunCompletionStatus = RunCompletedPayload['status']

export interface SessionPromptRun {
  runId: string
  completion: PromiseLike<RunCompletionStatus | { status: RunCompletionStatus }>
}

export type KernelMethodHandler = (
  params: JsonValue,
  context: KernelCallContext,
  request: KernelRequestFrame
) => JsonValue | SessionPromptRun | Promise<JsonValue | SessionPromptRun>

export type KernelBusinessMethod = Exclude<KernelV1Method, 'kernel.hello'>

export type KernelMethodHandlers = Partial<Record<KernelBusinessMethod, KernelMethodHandler>> & {
  onControllerDetached?: (generation: number) => void | Promise<void>
}

export interface KernelProtocolLogger {
  debug?(message: string, details?: Readonly<Record<string, JsonValue>>): void
  warn?(message: string, details?: Readonly<Record<string, JsonValue>>): void
  error?(message: string, details?: Readonly<Record<string, JsonValue>>): void
}

export interface KernelProtocolOptions {
  kernelVersion: string
  ompVersion: string
  handlers?: KernelMethodHandlers
  replayCapacity?: number
  kernelInstanceId?: string
  log?: KernelProtocolLogger
}

export interface AttachTransportOptions {
  trusted: boolean
  connectionId?: string
  /** Trusted entry metadata; K1-1's stdio entry intentionally registers none. */
  hostCapabilities?: readonly string[]
}
