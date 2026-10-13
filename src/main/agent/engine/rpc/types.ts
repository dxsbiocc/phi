import type { PhiToolResult } from '../types'
import type { RemoteStdioProcess } from '../../wrappers/remote-ssh-session'

export type RpcTransport = RemoteStdioProcess
export type RpcTransportFactory = (signal: AbortSignal) => RpcTransport | Promise<RpcTransport>

export interface RpcFrame {
  type: string
  [key: string]: unknown
}

export interface RpcCommand {
  type: string
  id?: never
  [key: string]: unknown
}

export interface RpcResponse extends RpcFrame {
  type: 'response'
  id: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

export interface RpcPromptResult extends RpcFrame {
  type: 'prompt_result'
  id: string
  agentInvoked: boolean
  status: 'completed' | 'aborted' | 'error'
  sessionSettled: boolean
  error?: {
    message: string
    retryable: boolean
    provider?: string
    model?: string
    httpStatus?: number
  }
}

export interface RpcPromptOptions {
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
  streamingBehavior?: 'steer' | 'followUp'
  /** Zero disables the completion deadline; admission still has the request deadline. */
  timeoutMs?: number
}

export interface RpcRequestOptions {
  timeoutMs?: number
}

export interface RpcConnectionOptions {
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  /** Default zero: long-running prompts are stopped explicitly, not replayed on timeout. */
  promptTimeoutMs?: number
  closeTimeoutMs?: number
}

export interface RpcDisconnect {
  error: Error
  generation: number
  expected: boolean
}

/** Explicit desktop tool metadata only; credentials and execution authority stay local. */
export interface RpcHostToolDefinition {
  name: string
  label?: string
  description: string
  parameters: Record<string, unknown>
  hidden?: boolean
  loadMode?: 'essential' | 'discoverable'
  readsSkillUris?: boolean
}

export interface RpcHostToolCall extends RpcFrame {
  type: 'host_tool_call'
  id: string
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
}

export interface RpcHostToolCancel extends RpcFrame {
  type: 'host_tool_cancel'
  id: string
  targetId: string
}

export type RpcControlFrame =
  | { type: 'host_tool_update'; id: string; partialResult: PhiToolResult }
  | { type: 'host_tool_result'; id: string; result: PhiToolResult; isError?: boolean }
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true; timedOut?: boolean }
  | {
      type: 'extension_ui_response'
      id: string
      answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }>
    }

/** Captures one ready generation; it cannot write to or observe a replacement channel. */
export interface RpcControlChannel {
  readonly generation: number
  readonly signal: AbortSignal
  sendControl(frame: RpcControlFrame): Promise<void>
  onFrame(listener: (frame: RpcFrame) => void): () => void
}
