import { randomUUID } from 'node:crypto'
import type {
  JsonObject,
  JsonValue,
  NotebookCell,
  NotebookOutput
} from '../../../shared/notebookDocument'
import { errorMessage } from '../../../shared/errorCodes'
import type { JupyterServerConnection } from './analysis-jupyter-server'
import { jupyterConnectionIdentity, jupyterWebSocketToken } from './jupyter-runtime-backend'

export type AnalysisCellExecutionState = 'idle' | 'error'

export interface ExecuteNotebookCellInput {
  connection: JupyterServerConnection
  sessionId: string
  kernelId: string
  cell: NotebookCell
}

export interface IntrospectNotebookVariablesInput {
  connection: JupyterServerConnection
  sessionId: string
  kernelId: string
  variableNames: string[]
  language?: string
}

export interface CompleteNotebookCodeInput {
  connection: JupyterServerConnection
  sessionId: string
  kernelId: string
  code: string
  cursorPosition: number
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
  silent?: boolean
  storeHistory?: boolean
}

export interface JupyterKernelExecuteResult {
  executionCount: number | null
  outputs: NotebookOutput[]
  status: 'ok' | 'error'
}

export interface JupyterKernelCompletionResult {
  matches: string[]
  cursorStart: number
  cursorEnd: number
  metadata: JsonObject
  status: 'ok' | 'error'
  message?: string
}

export class JupyterKernelExecutionStoppedError extends Error {
  constructor(reason: unknown) {
    super(reason instanceof Error ? reason.message : 'Notebook execution stopped', {
      cause: reason
    })
    this.name = 'JupyterKernelExecutionStoppedError'
  }
}

/** Sent code may still be running, or a failed interrupt may still arrive late. */
export class JupyterKernelExecutionUnconfirmedError extends Error {
  constructor(
    cause: unknown,
    readonly released: Promise<void>,
    readonly retire: () => void
  ) {
    super(`Notebook 停止未确认 kernel 终止: ${errorMessage(cause)}`, { cause })
    this.name = 'JupyterKernelExecutionUnconfirmedError'
  }
}

export interface JupyterKernelExecutionControl {
  signal?: AbortSignal
  checkCurrent?: () => void
  interrupt: () => Promise<void>
}

export interface JupyterKernelClient {
  executeCode(
    request: JupyterKernelExecuteRequest,
    control?: JupyterKernelExecutionControl
  ): Promise<JupyterKernelExecuteResult>
  completeCode(request: CompleteNotebookCodeInput): Promise<JupyterKernelCompletionResult>
}

export interface NotebookVariableIntrospection {
  name: string
  exists: boolean
  datatype?: string
  shape?: string
  columns?: Array<{ name: string; type?: string }>
  preview?: string
  error?: string
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

export type KernelWebSocketEvent = {
  data?: unknown
  message?: string
}

export type KernelWebSocket = {
  send(data: string): void
  close(): void
  addEventListener(event: 'open', listener: () => void): void
  addEventListener(event: 'message', listener: (event: KernelWebSocketEvent) => void): void
  addEventListener(event: 'error', listener: (event: KernelWebSocketEvent) => void): void
  addEventListener(event: 'close', listener: () => void): void
}

export type KernelWebSocketConstructor = new (url: string) => KernelWebSocket

// Real analysis cells (data loading, model training, etc.) routinely run far
// longer than a typical request timeout. Only give up if the kernel truly
// stops responding, not because a cell is legitimately still computing.
const EXECUTION_TIMEOUT_MS = 30 * 60_000
const COMPLETION_TIMEOUT_MS = 10_000
const VARIABLE_INTROSPECTION_SENTINEL = '__PHI_NOTEBOOK_VARIABLES__'
const PYTHON_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const R_IDENTIFIER_PATTERN = /^(?:[A-Za-z]|\.(?!\d))[A-Za-z0-9._]*$/

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

export function normalizeJupyterKernelCompletionMessages(
  messages: RawJupyterKernelMessage[],
  fallbackPosition: number
): JupyterKernelCompletionResult {
  const reply = messages.find((message) => messageType(message) === 'complete_reply')
  const content = jsonObject(reply?.content)
  if (!content) {
    return {
      matches: [],
      cursorStart: fallbackPosition,
      cursorEnd: fallbackPosition,
      metadata: {},
      status: 'error',
      message: 'Jupyter kernel did not return completion results'
    }
  }

  const matches = Array.isArray(content.matches)
    ? content.matches.filter((item): item is string => typeof item === 'string')
    : []
  const cursorStart = numberValue(content.cursor_start) ?? fallbackPosition
  const cursorEnd = numberValue(content.cursor_end) ?? fallbackPosition
  return {
    matches,
    cursorStart,
    cursorEnd: Math.max(cursorStart, cursorEnd),
    metadata: toJsonObject(content.metadata),
    status: content.status === 'ok' ? 'ok' : 'error',
    message: stringValue(content.message)
  }
}

function isRNotebookLanguage(language: string | undefined): boolean {
  const value = language?.toLocaleLowerCase()
  return value === 'r' || value === 'ir' || value === 'rscript'
}

function safeVariableNames(variableNames: string[], language?: string): string[] {
  const pattern = isRNotebookLanguage(language) ? R_IDENTIFIER_PATTERN : PYTHON_IDENTIFIER_PATTERN
  return [...new Set(variableNames.filter((name) => pattern.test(name)))]
}

function buildPythonNotebookVariableIntrospectionCode(names: string[]): string {
  return [
    'exec(',
    JSON.stringify(
      [
        'import json',
        '',
        'def _phi_safe_text(value, limit=1200):',
        '    try:',
        '        text = str(value)',
        '    except Exception as exc:',
        '        text = f"<repr failed: {type(exc).__name__}: {exc}>"',
        '    return text if len(text) <= limit else text[:limit - 1] + "…"',
        '',
        'def _phi_shape(value):',
        '    shape = getattr(value, "shape", None)',
        '    if shape is None:',
        '        return None',
        '    try:',
        '        if isinstance(shape, tuple):',
        '            return " x ".join(str(part) for part in shape)',
        '        return _phi_safe_text(shape, 160)',
        '    except Exception:',
        '        return None',
        '',
        'def _phi_columns(value, limit=30):',
        '    columns = getattr(value, "columns", None)',
        '    if columns is None:',
        '        return None',
        '    dtypes = getattr(value, "dtypes", None)',
        '    result = []',
        '    try:',
        '        iterable = list(columns)[:limit]',
        '    except Exception:',
        '        return None',
        '    for column in iterable:',
        '        item = {"name": _phi_safe_text(column, 120)}',
        '        try:',
        '            dtype = dtypes[column] if dtypes is not None else None',
        '            if dtype is not None:',
        '                item["type"] = _phi_safe_text(dtype, 120)',
        '        except Exception:',
        '            pass',
        '        result.append(item)',
        '    return result',
        '',
        'def _phi_preview(value):',
        '    try:',
        '        head = value.head(5) if hasattr(value, "head") else None',
        '        if head is not None:',
        '            if hasattr(head, "to_markdown"):',
        '                return _phi_safe_text(head.to_markdown(index=False), 2000)',
        '            return _phi_safe_text(head, 2000)',
        '    except Exception:',
        '        pass',
        '    return _phi_safe_text(value, 1200)',
        '',
        'def _phi_variable(name):',
        '    if name not in _phi_ns:',
        '        return {"name": name, "exists": False}',
        '    value = _phi_ns[name]',
        '    item = {',
        '        "name": name,',
        '        "exists": True,',
        '        "datatype": f"{type(value).__module__}.{type(value).__qualname__}",',
        '        "preview": _phi_preview(value),',
        '    }',
        '    shape = _phi_shape(value)',
        '    if shape:',
        '        item["shape"] = shape',
        '    columns = _phi_columns(value)',
        '    if columns:',
        '        item["columns"] = columns',
        '    return item',
        '',
        'payload = {"variables": []}',
        'for _phi_name in _phi_names:',
        '    try:',
        '        payload["variables"].append(_phi_variable(_phi_name))',
        '    except Exception as exc:',
        '        payload["variables"].append({',
        '            "name": _phi_name,',
        '            "exists": True,',
        '            "error": f"{type(exc).__name__}: {exc}",',
        '        })',
        `print("${VARIABLE_INTROSPECTION_SENTINEL}" + json.dumps(payload, ensure_ascii=False))`
      ].join('\n')
    ),
    `, {"__builtins__": __builtins__, "_phi_names": ${JSON.stringify(names)}, "_phi_ns": globals()}, {})`
  ].join('')
}

function rStringVector(values: string[]): string {
  if (values.length === 0) return 'character()'
  return `c(${values.map((value) => JSON.stringify(value)).join(', ')})`
}

function buildRNotebookVariableIntrospectionCode(names: string[]): string {
  return [
    'local({',
    `  .phi_names <- ${rStringVector(names)}`,
    '',
    '  .phi_safe_text <- function(value, limit = 1200) {',
    '    text <- tryCatch({',
    '      paste(utils::capture.output(print(value)), collapse = "\\n")',
    '    }, error = function(exc) {',
    '      paste0("<repr failed: ", class(exc)[1], ": ", conditionMessage(exc), ">")',
    '    })',
    '    if (nchar(text, type = "chars", allowNA = FALSE) <= limit) text else paste0(substr(text, 1, limit - 1), "…")',
    '  }',
    '',
    '  .phi_shape <- function(value) {',
    '    dims <- dim(value)',
    '    if (is.null(dims)) return(NULL)',
    '    paste(dims, collapse = " x ")',
    '  }',
    '',
    '  .phi_columns <- function(value, limit = 30) {',
    '    if (!inherits(value, "data.frame")) return(NULL)',
    '    column_names <- names(value)',
    '    if (is.null(column_names)) return(NULL)',
    '    column_names <- utils::head(column_names, limit)',
    '    lapply(column_names, function(column_name) {',
    '      column <- value[[column_name]]',
    '      list(name = as.character(column_name), type = paste(class(column), collapse = "/"))',
    '    })',
    '  }',
    '',
    '  .phi_preview <- function(value) {',
    '    if (inherits(value, "data.frame")) {',
    '      return(.phi_safe_text(utils::head(value, 5), 2000))',
    '    }',
    '    tryCatch({',
    '      paste(utils::capture.output(str(value, max.level = 1, give.attr = FALSE)), collapse = "\\n")',
    '    }, error = function(exc) .phi_safe_text(value, 1200))',
    '  }',
    '',
    '  .phi_variable <- function(name) {',
    '    if (!exists(name, envir = .GlobalEnv, inherits = FALSE)) {',
    '      return(list(name = name, exists = FALSE))',
    '    }',
    '    value <- get(name, envir = .GlobalEnv, inherits = FALSE)',
    '    item <- list(',
    '      name = name,',
    '      exists = TRUE,',
    '      datatype = paste(class(value), collapse = ", "),',
    '      preview = .phi_preview(value)',
    '    )',
    '    shape <- .phi_shape(value)',
    '    if (!is.null(shape)) item$shape <- shape',
    '    columns <- .phi_columns(value)',
    '    if (!is.null(columns) && length(columns) > 0) item$columns <- columns',
    '    item',
    '  }',
    '',
    '  .phi_json_string <- function(value) {',
    '    if (is.null(value) || length(value) == 0 || is.na(value[[1]])) return("null")',
    '    text <- as.character(value[[1]])',
    '    text <- gsub("\\\\", "\\\\\\\\", text, fixed = TRUE)',
    '    text <- gsub("\\"", "\\\\\\"", text, fixed = TRUE)',
    '    text <- gsub("\\n", "\\\\n", text, fixed = TRUE)',
    '    text <- gsub("\\r", "\\\\r", text, fixed = TRUE)',
    '    text <- gsub("\\t", "\\\\t", text, fixed = TRUE)',
    '    paste0("\\"", text, "\\"")',
    '  }',
    '',
    '  .phi_pair <- function(key, value_json) paste0(.phi_json_string(key), ":", value_json)',
    '  .phi_object <- function(pairs) paste0("{", paste(pairs, collapse = ","), "}")',
    '',
    '  .phi_column_json <- function(column) {',
    '    pairs <- c(',
    '      .phi_pair("name", .phi_json_string(column$name)),',
    '      .phi_pair("type", .phi_json_string(column$type))',
    '    )',
    '    .phi_object(pairs)',
    '  }',
    '',
    '  .phi_variable_json <- function(item) {',
    '    pairs <- c(',
    '      .phi_pair("name", .phi_json_string(item$name)),',
    '      .phi_pair("exists", if (isTRUE(item$exists)) "true" else "false")',
    '    )',
    '    if (!is.null(item$datatype)) pairs <- c(pairs, .phi_pair("datatype", .phi_json_string(item$datatype)))',
    '    if (!is.null(item$shape)) pairs <- c(pairs, .phi_pair("shape", .phi_json_string(item$shape)))',
    '    if (!is.null(item$columns)) {',
    '      columns_json <- paste(vapply(item$columns, .phi_column_json, character(1)), collapse = ",")',
    '      pairs <- c(pairs, .phi_pair("columns", paste0("[", columns_json, "]")))',
    '    }',
    '    if (!is.null(item$preview)) pairs <- c(pairs, .phi_pair("preview", .phi_json_string(item$preview)))',
    '    if (!is.null(item$error)) pairs <- c(pairs, .phi_pair("error", .phi_json_string(item$error)))',
    '    .phi_object(pairs)',
    '  }',
    '',
    '  payload <- list(variables = lapply(.phi_names, function(.phi_name) {',
    '    tryCatch(.phi_variable(.phi_name), error = function(exc) {',
    '      list(name = .phi_name, exists = TRUE, error = paste0(class(exc)[1], ": ", conditionMessage(exc)))',
    '    })',
    '  }))',
    '',
    '  if (requireNamespace("jsonlite", quietly = TRUE)) {',
    `    cat("${VARIABLE_INTROSPECTION_SENTINEL}", jsonlite::toJSON(payload, auto_unbox = TRUE, null = "null", na = "null"), "\\n", sep = "")`,
    '  } else {',
    '    variables_json <- paste(vapply(payload$variables, .phi_variable_json, character(1)), collapse = ",")',
    `    cat("${VARIABLE_INTROSPECTION_SENTINEL}", "{\\"variables\\":[", variables_json, "]}", "\\n", sep = "")`,
    '  }',
    '})'
  ].join('\n')
}

export function buildNotebookVariableIntrospectionCode(
  variableNames: string[],
  language?: string
): string {
  const names = safeVariableNames(variableNames, language)
  return isRNotebookLanguage(language)
    ? buildRNotebookVariableIntrospectionCode(names)
    : buildPythonNotebookVariableIntrospectionCode(names)
}

export function parseNotebookVariableIntrospectionResult(
  result: JupyterKernelExecuteResult
): NotebookVariableIntrospection[] {
  if (result.status === 'error') return []
  const text = result.outputs
    .filter((output) => output.outputType === 'stream')
    .map((output) => output.text ?? '')
    .join('\n')
  const line = text.split(/\r?\n/).find((item) => item.startsWith(VARIABLE_INTROSPECTION_SENTINEL))
  if (!line) return []
  try {
    const parsed = JSON.parse(line.slice(VARIABLE_INTROSPECTION_SENTINEL.length)) as unknown
    const record = jsonObject(parsed)
    const variables = Array.isArray(record?.variables) ? record.variables : []
    return variables
      .map((item) => notebookVariableIntrospectionValue(item))
      .filter((item): item is NotebookVariableIntrospection => Boolean(item))
  } catch {
    return []
  }
}

function notebookVariableIntrospectionValue(value: unknown): NotebookVariableIntrospection | null {
  const record = jsonObject(value)
  const name = stringValue(record?.name)
  if (!record || !name) return null
  const columns = Array.isArray(record.columns)
    ? record.columns
        .map((column) => {
          const columnRecord = jsonObject(column)
          const columnName = stringValue(columnRecord?.name)
          if (!columnRecord || !columnName) return null
          const columnType = stringValue(columnRecord.type)
          return { name: columnName, ...(columnType ? { type: columnType } : {}) }
        })
        .filter((column): column is { name: string; type?: string } => Boolean(column))
    : undefined
  return {
    name,
    exists: record.exists === true,
    datatype: stringValue(record.datatype),
    shape: stringValue(record.shape),
    columns,
    preview: stringValue(record.preview),
    error: stringValue(record.error)
  }
}

function kernelChannelsUrl(
  connection: JupyterServerConnection,
  kernelId: string,
  sessionId: string
): string {
  const url = new URL(`/api/kernels/${encodeURIComponent(kernelId)}/channels`, connection.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('session_id', sessionId)
  const token = jupyterWebSocketToken(connection)
  if (token) url.searchParams.set('token', token)
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
  private readonly executionTimeoutMs: number
  private readonly completionTimeoutMs: number
  private readonly WebSocket?: KernelWebSocketConstructor

  constructor(
    options: {
      executionTimeoutMs?: number
      completionTimeoutMs?: number
      webSocketConstructor?: KernelWebSocketConstructor
    } = {}
  ) {
    this.executionTimeoutMs = positiveTimeout(options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS)
    this.completionTimeoutMs = positiveTimeout(options.completionTimeoutMs ?? COMPLETION_TIMEOUT_MS)
    if (options.webSocketConstructor) this.WebSocket = options.webSocketConstructor
  }

  async executeCode(
    request: JupyterKernelExecuteRequest,
    control?: JupyterKernelExecutionControl
  ): Promise<JupyterKernelExecuteResult> {
    control?.signal?.throwIfAborted()
    control?.checkCurrent?.()
    const msgId = randomUUID()
    const socket = this.openSocket(request.connection, request.kernelId, request.sessionId)
    let sawIdle = false
    let sawReply = false
    return collectKernelMessages(
      socket,
      executeRequestMessage(msgId, request),
      msgId,
      this.executionTimeoutMs,
      'Notebook cell execution timed out',
      'Jupyter kernel WebSocket closed before execution completed',
      (messages, message) => {
        const type = messageType(message)
        const content = jsonObject(message.content)
        if (type === 'execute_reply') sawReply = true
        if (type === 'status' && content?.execution_state === 'idle') sawIdle = true
        return sawIdle && sawReply ? normalizeJupyterKernelMessages(messages) : undefined
      },
      control,
      true
    )
  }

  async completeCode(request: CompleteNotebookCodeInput): Promise<JupyterKernelCompletionResult> {
    const msgId = randomUUID()
    const code = request.code
    const cursorPosition = Math.max(0, Math.min(request.cursorPosition, code.length))
    const socket = this.openSocket(request.connection, request.kernelId, request.sessionId)
    return collectKernelMessages(
      socket,
      completionRequestMessage(msgId, request, cursorPosition),
      msgId,
      this.completionTimeoutMs,
      'Notebook code completion timed out',
      'Jupyter kernel WebSocket closed before completion results arrived',
      (messages, message) =>
        messageType(message) === 'complete_reply'
          ? normalizeJupyterKernelCompletionMessages(messages, cursorPosition)
          : undefined
    )
  }

  private openSocket(
    connection: JupyterServerConnection,
    kernelId: string,
    sessionId: string
  ): KernelWebSocket {
    const Constructor = this.WebSocket ?? websocketConstructor()
    try {
      return new Constructor(kernelChannelsUrl(connection, kernelId, sessionId))
    } catch {
      throw new Error('无法连接 Jupyter kernel WebSocket')
    }
  }
}

function executeRequestMessage(msgId: string, request: JupyterKernelExecuteRequest): unknown {
  return kernelRequestMessage(msgId, request.sessionId, 'execute_request', {
    code: request.code,
    silent: request.silent ?? false,
    store_history: request.storeHistory ?? true,
    user_expressions: {},
    allow_stdin: false,
    stop_on_error: true
  })
}

function completionRequestMessage(
  msgId: string,
  request: CompleteNotebookCodeInput,
  cursorPosition: number
): unknown {
  return kernelRequestMessage(msgId, request.sessionId, 'complete_request', {
    code: request.code,
    cursor_pos: cursorPosition
  })
}

function kernelRequestMessage(
  msgId: string,
  sessionId: string,
  messageTypeName: string,
  content: Record<string, unknown>
): unknown {
  return {
    header: {
      msg_id: msgId,
      username: 'phi',
      session: sessionId,
      date: new Date().toISOString(),
      msg_type: messageTypeName,
      version: '5.3'
    },
    parent_header: {},
    metadata: {},
    content,
    channel: 'shell'
  }
}

function collectKernelMessages<T>(
  socket: KernelWebSocket,
  requestMessage: unknown,
  msgId: string,
  timeoutMs: number,
  timeoutMessage: string,
  closeMessage: string,
  resolveWhen: (
    messages: RawJupyterKernelMessage[],
    message: RawJupyterKernelMessage
  ) => T | undefined,
  control?: JupyterKernelExecutionControl,
  ownsExecution = false
): Promise<T> {
  return new Promise((resolve, reject) => {
    const messages: RawJupyterKernelMessage[] = []
    let settled = false
    let sent = false
    let stopReason: unknown
    let interruptPending = false
    let interruptAttempted = false
    let interruptError: unknown
    let terminal = false
    let result: T | undefined
    let failure: unknown
    let resolveRelease!: () => void
    const released = new Promise<void>((resolve) => {
      resolveRelease = resolve
    })
    let quarantined = false
    const retire = (): void => {
      quarantined = false
      socket.close()
      resolveRelease()
    }
    const terminalRelease = (): void => {
      if (terminal && (!interruptAttempted || (!interruptPending && !interruptError)))
        resolveRelease()
      if (terminal && settled) {
        quarantined = false
        socket.close()
      }
    }
    const uncertain = (cause: unknown): JupyterKernelExecutionUnconfirmedError =>
      new JupyterKernelExecutionUnconfirmedError(cause, released, retire)
    const settle = (error?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      control?.signal?.removeEventListener('abort', onAbort)
      quarantined = error instanceof JupyterKernelExecutionUnconfirmedError && !terminal
      if (!quarantined) socket.close()
      terminalRelease()
      if (error) reject(error)
      else resolve(result as T)
    }
    const finish = (): void => {
      if (settled || interruptPending) return
      terminalRelease()
      if (stopReason) {
        if (interruptError) settle(uncertain(interruptError))
        else if (!sent || terminal) settle(new JupyterKernelExecutionStoppedError(stopReason))
        else if (failure) settle(uncertain(failure))
      } else if (failure || terminal) {
        settle(failure && ownsExecution && sent && !terminal ? uncertain(failure) : failure)
      }
    }
    const stop = (reason: unknown): void => {
      if (settled || stopReason) return
      stopReason = reason || new Error('Notebook execution stopped')
      if (sent && !terminal && control) {
        // Keep the socket and execution lock until physical interrupt acknowledgement
        // and terminal reply/idle. A rejected interrupt is never reported as success.
        interruptAttempted = true
        interruptPending = true
        Promise.resolve()
          .then(control.interrupt)
          .catch((error: unknown) => {
            interruptError = error || new Error('Jupyter kernel interrupt failed')
          })
          .finally(() => {
            interruptPending = false
            terminalRelease()
            finish()
          })
      }
      finish()
    }
    const onAbort = (): void => stop(control?.signal?.reason)
    const checkCurrent = (): void => {
      control?.signal?.throwIfAborted()
      control?.checkCurrent?.()
    }
    const fail = (error: unknown): void => {
      failure = error
      finish()
    }
    const timeout = setTimeout(() => fail(new Error(timeoutMessage)), timeoutMs)
    control?.signal?.addEventListener('abort', onAbort, { once: true })
    if (control?.signal?.aborted) onAbort()
    socket.addEventListener('open', () => {
      if (settled || stopReason) return
      try {
        checkCurrent()
        sent = true
        socket.send(JSON.stringify(requestMessage))
      } catch (error) {
        stop(error)
      }
    })
    socket.addEventListener('message', (event) => {
      if (settled && !quarantined) return
      try {
        const message = parseKernelMessage(event)
        if (message.parent_header?.msg_id !== msgId) return
        if (!stopReason && !settled) {
          try {
            checkCurrent()
          } catch (error) {
            stop(error)
          }
        }
        if (!stopReason && !settled) messages.push(message)
        if (!terminal) {
          result = resolveWhen(messages, message)
          terminal = result !== undefined
        }
        terminalRelease()
        finish()
      } catch {
        fail(new Error('Jupyter kernel message 无效'))
      }
    })
    socket.addEventListener('error', () => fail(new Error('Jupyter kernel WebSocket error')))
    socket.addEventListener('close', () => fail(new Error(closeMessage)))
  })
}

function parseKernelMessage(event: KernelWebSocketEvent): RawJupyterKernelMessage {
  const raw =
    typeof event.data === 'string'
      ? event.data
      : Buffer.from(event.data as ArrayBuffer).toString('utf8')
  return JSON.parse(raw) as RawJupyterKernelMessage
}

function positiveTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Jupyter timeout 必须为正数')
  return value
}

export class AnalysisNotebookExecutor {
  private readonly client: JupyterKernelClient
  private readonly now: () => Date
  private readonly activeKernels = new Map<string, { retire?: () => void }>()

  constructor(options: { client?: JupyterKernelClient; now?: () => Date } = {}) {
    this.client = options.client ?? new WebSocketJupyterKernelClient()
    this.now = options.now ?? (() => new Date())
  }

  isExecuting(input: Pick<ExecuteNotebookCellInput, 'connection' | 'kernelId'>): boolean {
    return this.activeKernels.has(
      `${jupyterConnectionIdentity(input.connection)}\0${input.kernelId}`
    )
  }

  /** Call only after the captured kernel has been explicitly retired/rebuilt. */
  retireKernel(input: Pick<ExecuteNotebookCellInput, 'connection' | 'kernelId'>): void {
    this.activeKernels
      .get(`${jupyterConnectionIdentity(input.connection)}\0${input.kernelId}`)
      ?.retire?.()
  }

  private async executeLocked<T>(
    input: Pick<ExecuteNotebookCellInput, 'connection' | 'kernelId'>,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = `${jupyterConnectionIdentity(input.connection)}\0${input.kernelId}`
    if (this.activeKernels.has(key)) throw new Error('Notebook kernel 正在执行，不能重叠运行 cell')
    const owner: { retire?: () => void } = {}
    this.activeKernels.set(key, owner)
    const release = (): void => {
      if (this.activeKernels.get(key) === owner) this.activeKernels.delete(key)
    }
    try {
      return await operation()
    } catch (error) {
      if (error instanceof JupyterKernelExecutionUnconfirmedError) {
        owner.retire = () => {
          error.retire()
          release()
        }
        void error.released.then(release)
      }
      throw error
    } finally {
      if (!owner.retire) release()
    }
  }

  async executeCell(
    input: ExecuteNotebookCellInput,
    control?: JupyterKernelExecutionControl
  ): Promise<ExecutedNotebookCell> {
    if (input.cell.cellType !== 'code') {
      throw new Error('只能执行 code cell')
    }
    return this.executeLocked(input, async () => {
      const startedAt = this.now().toISOString()
      const result = await this.client.executeCode(
        {
          connection: input.connection,
          sessionId: input.sessionId,
          kernelId: input.kernelId,
          code: input.cell.source
        },
        control
      )
      return {
        cellId: input.cell.id,
        executionCount: result.executionCount,
        outputs: result.outputs,
        state: result.status === 'error' ? 'error' : 'idle',
        startedAt,
        completedAt: this.now().toISOString()
      }
    })
  }

  async introspectVariables(
    input: IntrospectNotebookVariablesInput
  ): Promise<NotebookVariableIntrospection[]> {
    const variableNames = safeVariableNames(input.variableNames, input.language)
    if (variableNames.length === 0) return []
    if (this.isExecuting(input)) return []
    return this.executeLocked(input, async () => {
      const result = await this.client.executeCode({
        connection: input.connection,
        sessionId: input.sessionId,
        kernelId: input.kernelId,
        code: buildNotebookVariableIntrospectionCode(variableNames, input.language),
        storeHistory: false
      })
      return parseNotebookVariableIntrospectionResult(result)
    })
  }

  async completeCode(input: CompleteNotebookCodeInput): Promise<JupyterKernelCompletionResult> {
    return this.client.completeCode({
      ...input,
      cursorPosition: Math.max(0, Math.min(input.cursorPosition, input.code.length))
    })
  }
}
