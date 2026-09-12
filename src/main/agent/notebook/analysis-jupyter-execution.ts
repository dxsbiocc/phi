import { randomUUID } from 'node:crypto'
import type {
  JsonObject,
  JsonValue,
  NotebookCell,
  NotebookOutput
} from '../../../shared/notebookDocument'
import type { JupyterServerConnection } from './analysis-jupyter-server'

export type AnalysisCellExecutionState = 'idle' | 'error'

export interface ExecuteNotebookCellInput {
  connection: JupyterServerConnection
  sessionId: string
  kernelId: string
  cell: NotebookCell
}

export interface ExecutedNotebookCell {
  cellId: string
  executionCount: number | null
  outputs: NotebookOutput[]
  state: AnalysisCellExecutionState
  startedAt: string
  completedAt: string
}

export interface JupyterKernelExecuteRequest {
  connection: JupyterServerConnection
  sessionId: string
  kernelId: string
  code: string
}

export interface JupyterKernelExecuteResult {
  executionCount: number | null
  outputs: NotebookOutput[]
  status: 'ok' | 'error'
}

export interface JupyterKernelClient {
  executeCode(request: JupyterKernelExecuteRequest): Promise<JupyterKernelExecuteResult>
}

export type RawJupyterKernelMessage = {
  channel?: unknown
  header?: {
    msg_type?: unknown
  }
  parent_header?: {
    msg_id?: unknown
  }
  content?: unknown
}

type KernelWebSocketEvent = {
  data?: unknown
  message?: string
}

type KernelWebSocket = {
  send(data: string): void
  close(): void
  addEventListener(event: 'open', listener: () => void): void
  addEventListener(event: 'message', listener: (event: KernelWebSocketEvent) => void): void
  addEventListener(event: 'error', listener: (event: KernelWebSocketEvent) => void): void
  addEventListener(event: 'close', listener: () => void): void
}

type KernelWebSocketConstructor = new (url: string) => KernelWebSocket

// Real analysis cells (data loading, model training, etc.) routinely run far
// longer than a typical request timeout. Only give up if the kernel truly
// stops responding, not because a cell is legitimately still computing.
const EXECUTION_TIMEOUT_MS = 30 * 60_000

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length === value.length ? strings : undefined
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : '')).join('')
  }
  return ''
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    const values = value.map(toJsonValue)
    return values.every((item): item is JsonValue => item !== undefined) ? values : undefined
  }
  const object = jsonObject(value)
  if (!object) return undefined
  const result: JsonObject = {}
  for (const [key, item] of Object.entries(object)) {
    const json = toJsonValue(item)
    if (json !== undefined) result[key] = json
  }
  return result
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value)
  return jsonObject(json) ? (json as JsonObject) : {}
}

function messageType(message: RawJupyterKernelMessage): string | undefined {
  return stringValue(message.header?.msg_type)
}

export function normalizeJupyterKernelMessages(
  messages: RawJupyterKernelMessage[]
): JupyterKernelExecuteResult {
  const outputs: NotebookOutput[] = []
  let executionCount: number | null = null
  let status: 'ok' | 'error' = 'ok'

  for (const message of messages) {
    const content = jsonObject(message.content)
    if (!content) continue
    const type = messageType(message)
    if (type === 'execute_input') {
      executionCount = numberValue(content.execution_count)
      continue
    }
    if (type === 'execute_reply') {
      executionCount = numberValue(content.execution_count) ?? executionCount
      if (content.status === 'error') status = 'error'
      continue
    }
    if (type === 'stream') {
      outputs.push({
        outputType: 'stream',
        data: {},
        metadata: {},
        name: stringValue(content.name) ?? 'stdout',
        text: textValue(content.text),
        extra: {}
      })
      continue
    }
    if (type === 'execute_result') {
      const outputExecutionCount = numberValue(content.execution_count)
      executionCount = outputExecutionCount ?? executionCount
      outputs.push({
        outputType: 'execute_result',
        data: toJsonObject(content.data),
        metadata: toJsonObject(content.metadata),
        executionCount: outputExecutionCount,
        extra: {}
      })
      continue
    }
    if (type === 'display_data' || type === 'update_display_data') {
      outputs.push({
        outputType: type,
        data: toJsonObject(content.data),
        metadata: toJsonObject(content.metadata),
        extra: {}
      })
      continue
    }
    if (type === 'error') {
      status = 'error'
      outputs.push({
        outputType: 'error',
        data: {},
        metadata: {},
        ename: stringValue(content.ename),
        evalue: stringValue(content.evalue),
        traceback: stringArrayValue(content.traceback),
        extra: {}
      })
    }
  }

  return { executionCount, outputs, status }
}

function kernelChannelsUrl(
  connection: JupyterServerConnection,
  kernelId: string,
  sessionId: string
): string {
  const url = new URL(`/api/kernels/${encodeURIComponent(kernelId)}/channels`, connection.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('session_id', sessionId)
  if (connection.token) url.searchParams.set('token', connection.token)
  return url.toString()
}

function websocketConstructor(): KernelWebSocketConstructor {
  const candidate = (globalThis as { WebSocket?: KernelWebSocketConstructor }).WebSocket
  if (!candidate) {
    throw new Error('当前运行环境不支持 WebSocket，无法执行 notebook cell')
  }
  return candidate
}

export class WebSocketJupyterKernelClient implements JupyterKernelClient {
  async executeCode(request: JupyterKernelExecuteRequest): Promise<JupyterKernelExecuteResult> {
    const Constructor = websocketConstructor()
    const msgId = randomUUID()
    const socket = new Constructor(
      kernelChannelsUrl(request.connection, request.kernelId, request.sessionId)
    )

    return new Promise((resolve, reject) => {
      const messages: RawJupyterKernelMessage[] = []
      let sawIdle = false
      let sawReply = false
      const timeout = setTimeout(() => {
        socket.close()
        reject(new Error('Notebook cell execution timed out'))
      }, EXECUTION_TIMEOUT_MS)

      const finish = (): void => {
        if (!sawIdle || !sawReply) return
        clearTimeout(timeout)
        socket.close()
        resolve(normalizeJupyterKernelMessages(messages))
      }

      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            header: {
              msg_id: msgId,
              username: 'phi',
              session: request.sessionId,
              date: new Date().toISOString(),
              msg_type: 'execute_request',
              version: '5.3'
            },
            parent_header: {},
            metadata: {},
            content: {
              code: request.code,
              silent: false,
              store_history: true,
              user_expressions: {},
              allow_stdin: false,
              stop_on_error: true
            },
            channel: 'shell'
          })
        )
      })
      socket.addEventListener('message', (event) => {
        try {
          const raw =
            typeof event.data === 'string'
              ? event.data
              : Buffer.from(event.data as ArrayBuffer).toString('utf8')
          const message = JSON.parse(raw) as RawJupyterKernelMessage
          if (message.parent_header?.msg_id !== msgId) return
          messages.push(message)
          const type = messageType(message)
          const content = jsonObject(message.content)
          if (type === 'execute_reply') sawReply = true
          if (type === 'status' && content?.execution_state === 'idle') sawIdle = true
          finish()
        } catch (error) {
          clearTimeout(timeout)
          socket.close()
          reject(error)
        }
      })
      socket.addEventListener('error', (event) => {
        clearTimeout(timeout)
        socket.close()
        reject(new Error(errorMessage(event.message ?? 'Jupyter kernel WebSocket error')))
      })
      socket.addEventListener('close', () => {
        clearTimeout(timeout)
        if (!sawIdle || !sawReply) {
          reject(new Error('Jupyter kernel WebSocket closed before execution completed'))
        }
      })
    })
  }
}

export class AnalysisNotebookExecutor {
  private readonly client: JupyterKernelClient
  private readonly now: () => Date

  constructor(options: { client?: JupyterKernelClient; now?: () => Date } = {}) {
    this.client = options.client ?? new WebSocketJupyterKernelClient()
    this.now = options.now ?? (() => new Date())
  }

  async executeCell(input: ExecuteNotebookCellInput): Promise<ExecutedNotebookCell> {
    if (input.cell.cellType !== 'code') {
      throw new Error('只能执行 code cell')
    }
    const startedAt = this.now().toISOString()
    const result = await this.client.executeCode({
      connection: input.connection,
      sessionId: input.sessionId,
      kernelId: input.kernelId,
      code: input.cell.source
    })
    return {
      cellId: input.cell.id,
      executionCount: result.executionCount,
      outputs: result.outputs,
      state: result.status === 'error' ? 'error' : 'idle',
      startedAt,
      completedAt: this.now().toISOString()
    }
  }
}
