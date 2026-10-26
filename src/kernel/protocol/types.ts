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
  /** Negotiated desktop services from the active trusted controller; never request payload data. */
  hostCapabilities?: ReadonlySet<string>
}

export interface KernelHostRequestContext {
  sessionId?: string
  runId?: string
  agentRunId?: string
}

export type KernelHostProgressHandler = (progress: JsonValue) => void

export type RunCompletionStatus = RunCompletedPayload['status']

export interface SessionPromptRun {
  runId: string
  completion: PromiseLike<RunCompletionStatus | { status: RunCompletionStatus; detail?: string }>
}

export type KernelMethodHandler = (
  params: JsonValue,
  context: KernelCallContext,
  request: KernelRequestFrame
) => JsonValue | SessionPromptRun | Promise<JsonValue | SessionPromptRun>

export type SessionPromptConflict = {
  runId: string
  status: 'running'
}

export type SessionPromptConflictHandler = (
  sessionId: string,
  params: JsonValue,
  context: KernelCallContext,
  request: KernelRequestFrame
) => SessionPromptConflict | undefined | Promise<SessionPromptConflict | undefined>

export type KernelBusinessMethod = Exclude<KernelV1Method, 'kernel.hello'>

export type KernelMethodHandlers = Partial<Record<KernelBusinessMethod, KernelMethodHandler>> & {
  promptConflict?: SessionPromptConflictHandler
  onControllerDetached?: (generation: number) => void | Promise<void>
  onRunCompleted?: (
    sessionId: string,
    runId: string,
    status: RunCompletionStatus
  ) => void | Promise<void>
  runCompletionMetadata?: (sessionId: string) => {
    readonly model?: { readonly provider: string; readonly id: string }
    readonly resourceVersion?: string
  }
}

export interface KernelProtocolLogger {
  debug?(message: string, details?: Readonly<Record<string, JsonValue>>): void
  warn?(message: string, details?: Readonly<Record<string, JsonValue>>): void
  error?(message: string, details?: Readonly<Record<string, JsonValue>>): void
}

export interface KernelControllerLifecycle {
  onControllerAttached?(generation: number): void
  onControllerDetached?(generation: number): void
}

export interface KernelProtocolOptions {
  kernelVersion: string
  ompVersion: string
  handlers?: KernelMethodHandlers
  replayCapacity?: number
  kernelInstanceId?: string
  log?: KernelProtocolLogger
  disconnectPolicy?: 'fail-pending' | 'wait-for-reconnect'
  /** Test-only override for registry-declared service capability timeouts. */
  hostRequestTimeoutMs?: number
  controllerLifecycle?: KernelControllerLifecycle
  /** Trusted process identity used by attach clients to reject stale runtime roots. */
  runtimeIdentity?: { readonly home: string; readonly agentDir: string; readonly pid?: number }
}

export interface AttachTransportOptions {
  trusted: boolean
  connectionId?: string
}
