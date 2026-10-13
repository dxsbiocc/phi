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
