import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS
} from '../../shared/terminalTypes'

export const TERMINAL_MAX_FRAME_BYTES = 256 * 1024
export const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u

const MAX_REQUEST_ID_BYTES = 256
const MAX_PATH_BYTES = 16 * 1024
const MAX_ARGUMENT_BYTES = 16 * 1024
const MAX_ARGUMENTS = 256
const MAX_ENVIRONMENT_ENTRIES = 256
const MAX_ENVIRONMENT_KEY_BYTES = 256
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024
const MAX_ERROR_BYTES = 16 * 1024
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

export class TerminalProtocolError extends Error {
  constructor(message = 'Invalid terminal protocol frame') {
    super(message)
    this.name = 'TerminalProtocolError'
  }
}

export type TerminalCloseMode = 'user' | 'quit'

export interface TerminalDataRecord {
  seq: number
  data: string
}

export interface TerminalGap {
  fromSeq: number
  toSeq: number
  droppedBytes: number
}

export interface WorkerReplayResult {
  records: TerminalDataRecord[]
  gap?: TerminalGap
  nextSeq: number
  more: boolean
}

export interface SupervisorTerminationResult {
  allExited: boolean
  survivors: number[]
}

export type WorkerRequest =
  | {
      id: string
      type: 'create'
      terminalId: string
      application: string
      args: string[]
      cwd: string
      env: Record<string, string>
      cols: number
      rows: number
    }
  | { id: string; type: 'input'; terminalId: string; data: string }
  | { id: string; type: 'resize'; terminalId: string; cols: number; rows: number }
  | { id: string; type: 'kill'; terminalId: string }
  | { id: string; type: 'credit'; terminalId: string; bytes: number }
  | { id: string; type: 'replay'; terminalId: string; fromSeq: number }
  | { id: string; type: 'ping' }

export type WorkerEvent =
  | { type: 'started'; terminalId: string; pid: number }
  | { type: 'data'; terminalId: string; seq: number; data: string }
  | ({ type: 'gap'; terminalId: string } & TerminalGap)
  | {
      type: 'exit'
      terminalId: string
      exitCode: number | null
      cancelled: boolean
      timedOut: boolean
    }
  | { type: 'error'; terminalId: string; message: string }

export type SupervisorRequest =
  | { id: string; type: 'register'; terminalId: string; pid: number }
  | { id: string; type: 'terminate'; terminalId: string; mode: TerminalCloseMode }
  | { id: string; type: 'terminateAll'; mode: TerminalCloseMode }
  | { id: string; type: 'forget'; terminalId: string }
  | { id: string; type: 'ping' }

export type ProtocolResponse<Result = unknown> =
  { id: string; ok: true; result: Result } | { id: string; ok: false; error: string }

export type WorkerResponse<Result = unknown> = ProtocolResponse<Result>
export type SupervisorResponse<Result = unknown> = ProtocolResponse<Result>
export type WorkerMessage = WorkerResponse | WorkerEvent

function invalid(message?: string): never {
  throw new TerminalProtocolError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid()
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const parsed = record(value)
  return hasExactKeys(parsed, expected) ? parsed : invalid()
}

function boundedString(
  value: unknown,
  maxBytes: number,
  options: { allowEmpty?: boolean; rejectNul?: boolean } = {}
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    (options.rejectNul && value.includes('\0')) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    return invalid()
  }
  return value
}

function requestId(value: unknown): string {
  return boundedString(value, MAX_REQUEST_ID_BYTES, { rejectNul: true })
}

function terminalId(value: unknown): string {
  const parsed = boundedString(value, 64)
  return TERMINAL_ID_PATTERN.test(parsed) ? parsed : invalid()
}

function positiveInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : invalid()
}

function safeInteger(value: unknown): number {
  return Number.isSafeInteger(value) ? (value as number) : invalid()
}

function dimension(value: unknown, min: number, max: number): number {
  const parsed = positiveInteger(value)
  return parsed >= min && parsed <= max ? parsed : invalid()
}

function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid()
}

function closeMode(value: unknown): TerminalCloseMode {
  return value === 'user' || value === 'quit' ? value : invalid()
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) return invalid()
  return value.map((item) =>
    boundedString(item, MAX_ARGUMENT_BYTES, { allowEmpty: true, rejectNul: true })
  )
}

function environment(value: unknown): Record<string, string> {
  const source = record(value)
  const entries = Object.entries(source)
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) return invalid()
  const result: Record<string, string> = {}
  for (const [key, rawValue] of entries) {
    if (
      !ENVIRONMENT_KEY_PATTERN.test(key) ||
      Buffer.byteLength(key, 'utf8') > MAX_ENVIRONMENT_KEY_BYTES
    ) {
      return invalid()
    }
    result[key] = boundedString(rawValue, MAX_ENVIRONMENT_VALUE_BYTES, {
      allowEmpty: true,
      rejectNul: true
    })
  }
  return result
}

function parseCreateRequest(value: unknown): Extract<WorkerRequest, { type: 'create' }> {
  const input = exactRecord(value, [
    'id',
    'type',
    'terminalId',
    'application',
    'args',
    'cwd',
    'env',
    'cols',
    'rows'
  ])
  if (input.type !== 'create') return invalid()
  return {
    id: requestId(input.id),
    type: 'create',
    terminalId: terminalId(input.terminalId),
    application: boundedString(input.application, MAX_PATH_BYTES, { rejectNul: true }),
    args: stringArray(input.args),
    cwd: boundedString(input.cwd, MAX_PATH_BYTES, { rejectNul: true }),
    env: environment(input.env),
    cols: dimension(input.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
    rows: dimension(input.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
  }
}

export function parseWorkerRequest(value: unknown): WorkerRequest {
  assertFrameSize(value)
  const input = record(value)
  switch (input.type) {
    case 'create':
      return parseCreateRequest(input)
    case 'input': {
      const parsed = exactRecord(input, ['id', 'type', 'terminalId', 'data'])
      return {
        id: requestId(parsed.id),
        type: 'input',
        terminalId: terminalId(parsed.terminalId),
        data: boundedString(parsed.data, TERMINAL_MAX_INPUT_BYTES, {
          allowEmpty: true,
          rejectNul: true
        })
      }
    }
    case 'resize': {
      const parsed = exactRecord(input, ['id', 'type', 'terminalId', 'cols', 'rows'])
      return {
        id: requestId(parsed.id),
        type: 'resize',
        terminalId: terminalId(parsed.terminalId),
        cols: dimension(parsed.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
        rows: dimension(parsed.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
      }
    }
    case 'kill':
      return parseWorkerTerminalOnlyRequest(input)
    case 'credit': {
      const parsed = exactRecord(input, ['id', 'type', 'terminalId', 'bytes'])
      const bytes = positiveInteger(parsed.bytes)
      return {
        id: requestId(parsed.id),
        type: 'credit',
        terminalId: terminalId(parsed.terminalId),
        bytes
      }
    }
    case 'replay': {
      const parsed = exactRecord(input, ['id', 'type', 'terminalId', 'fromSeq'])
      return {
        id: requestId(parsed.id),
        type: 'replay',
        terminalId: terminalId(parsed.terminalId),
        fromSeq: positiveInteger(parsed.fromSeq)
      }
    }
    case 'ping': {
      const parsed = exactRecord(input, ['id', 'type'])
      return { id: requestId(parsed.id), type: 'ping' }
    }
    default:
      return invalid()
  }
}

function parseWorkerTerminalOnlyRequest(value: unknown): Extract<WorkerRequest, { type: 'kill' }> {
  const input = exactRecord(value, ['id', 'type', 'terminalId'])
  if (input.type !== 'kill') return invalid()
  return { id: requestId(input.id), type: 'kill', terminalId: terminalId(input.terminalId) }
}

export function parseSupervisorRequest(value: unknown): SupervisorRequest {
  assertFrameSize(value)
  const input = record(value)
  switch (input.type) {
    case 'register': {
      const parsed = exactRecord(input, ['id', 'type', 'terminalId', 'pid'])
      return {
        id: requestId(parsed.id),
        type: 'register',
        terminalId: terminalId(parsed.terminalId),
        pid: positiveInteger(parsed.pid)
      }
    }
    case 'terminate': {
      const parsed = exactRecord(input, ['id', 'type', 'terminalId', 'mode'])
      return {
        id: requestId(parsed.id),
        type: 'terminate',
        terminalId: terminalId(parsed.terminalId),
        mode: closeMode(parsed.mode)
      }
    }
    case 'terminateAll': {
      const parsed = exactRecord(input, ['id', 'type', 'mode'])
      return { id: requestId(parsed.id), type: 'terminateAll', mode: closeMode(parsed.mode) }
    }
    case 'forget': {
      const parsed = exactRecord(input, ['id', 'type', 'terminalId'])
      return { id: requestId(parsed.id), type: 'forget', terminalId: terminalId(parsed.terminalId) }
    }
    case 'ping': {
      const parsed = exactRecord(input, ['id', 'type'])
      return { id: requestId(parsed.id), type: 'ping' }
    }
    default:
      return invalid()
  }
}

function parseProtocolResponse(value: unknown): ProtocolResponse {
  assertFrameSize(value)
  const input = record(value)
  if (input.ok === true) {
    const parsed = exactRecord(input, ['id', 'ok', 'result'])
    return { id: requestId(parsed.id), ok: true, result: parsed.result }
  }
  if (input.ok === false) {
    const parsed = exactRecord(input, ['id', 'ok', 'error'])
    return {
      id: requestId(parsed.id),
      ok: false,
      error: boundedString(parsed.error, MAX_ERROR_BYTES)
    }
  }
  return invalid()
}

export function parseWorkerResponse(value: unknown): WorkerResponse {
  return parseProtocolResponse(value)
}

export function parseSupervisorResponse(value: unknown): SupervisorResponse {
  return parseProtocolResponse(value)
}

function parseNullResult(value: unknown): null {
  return value === null ? null : invalid()
}

function parseTrueResult(value: unknown, key: string): Record<string, true> {
  const input = exactRecord(value, [key])
  return input[key] === true ? { [key]: true } : invalid()
}

function parseBooleanResult(value: unknown, key: string): Record<string, boolean> {
  const input = exactRecord(value, [key])
  return { [key]: boolean(input[key]) }
}

export function parseWorkerResponseResult(type: string, value: unknown): unknown {
  switch (type) {
    case 'create': {
      const input = exactRecord(value, ['pid'])
      return { pid: positiveInteger(input.pid) }
    }
    case 'input':
    case 'resize':
    case 'credit':
      return parseNullResult(value)
    case 'kill':
      return parseBooleanResult(value, 'killed')
    case 'replay':
      return parseWorkerReplayResult(value)
    case 'ping':
      return parseTrueResult(value, 'pong')
    default:
      return invalid()
  }
}

export function parseSupervisorResponseResult(type: string, value: unknown): unknown {
  switch (type) {
    case 'register':
      return parseTrueResult(value, 'registered')
    case 'terminate':
    case 'terminateAll':
      return parseSupervisorTerminationResult(value)
    case 'forget':
      return parseBooleanResult(value, 'forgotten')
    case 'ping':
      return parseTrueResult(value, 'pong')
    default:
      return invalid()
  }
}

function parseWorkerEvent(value: unknown): WorkerEvent {
  assertFrameSize(value)
  const input = record(value)
  switch (input.type) {
    case 'started': {
      const parsed = exactRecord(input, ['type', 'terminalId', 'pid'])
      return {
        type: 'started',
        terminalId: terminalId(parsed.terminalId),
        pid: positiveInteger(parsed.pid)
      }
    }
    case 'data': {
      const parsed = exactRecord(input, ['type', 'terminalId', 'seq', 'data'])
      return {
        type: 'data',
        terminalId: terminalId(parsed.terminalId),
        seq: positiveInteger(parsed.seq),
        data: boundedString(parsed.data, TERMINAL_MAX_FRAME_BYTES, { allowEmpty: true })
      }
    }
    case 'gap': {
      const parsed = exactRecord(input, ['type', 'terminalId', 'fromSeq', 'toSeq', 'droppedBytes'])
      const gap = parseGap(parsed)
      return { type: 'gap', terminalId: terminalId(parsed.terminalId), ...gap }
    }
    case 'exit': {
      const parsed = exactRecord(input, ['type', 'terminalId', 'exitCode', 'cancelled', 'timedOut'])
      const exitCode = parsed.exitCode === null ? null : safeInteger(parsed.exitCode)
      return {
        type: 'exit',
        terminalId: terminalId(parsed.terminalId),
        exitCode,
        cancelled: boolean(parsed.cancelled),
        timedOut: boolean(parsed.timedOut)
      }
    }
    case 'error': {
      const parsed = exactRecord(input, ['type', 'terminalId', 'message'])
      return {
        type: 'error',
        terminalId: terminalId(parsed.terminalId),
        message: boundedString(parsed.message, MAX_ERROR_BYTES)
      }
    }
    default:
      return invalid()
  }
}

export function parseWorkerMessage(value: unknown): WorkerMessage {
  const input = record(value)
  return Object.hasOwn(input, 'id') ? parseWorkerResponse(input) : parseWorkerEvent(input)
}

function parseDataRecord(value: unknown): TerminalDataRecord {
  const input = exactRecord(value, ['seq', 'data'])
  return {
    seq: positiveInteger(input.seq),
    data: boundedString(input.data, TERMINAL_MAX_FRAME_BYTES, { allowEmpty: true })
  }
}

function parseGap(value: unknown): TerminalGap {
  const input = record(value)
  const fromSeq = positiveInteger(input.fromSeq)
  const toSeq = positiveInteger(input.toSeq)
  if (toSeq < fromSeq) return invalid()
  return { fromSeq, toSeq, droppedBytes: positiveInteger(input.droppedBytes) }
}

export function parseWorkerReplayResult(value: unknown): WorkerReplayResult {
  assertFrameSize(value)
  const input = record(value)
  const expected = ['records', 'nextSeq', 'more', ...(Object.hasOwn(input, 'gap') ? ['gap'] : [])]
  if (!hasExactKeys(input, expected) || !Array.isArray(input.records)) return invalid()
  const result: WorkerReplayResult = {
    records: input.records.map(parseDataRecord),
    nextSeq: positiveInteger(input.nextSeq),
    more: boolean(input.more)
  }
  if (Object.hasOwn(input, 'gap'))
    result.gap = parseGap(exactRecord(input.gap, ['fromSeq', 'toSeq', 'droppedBytes']))
  assertFrameSize(result)
  return result
}

export function parseSupervisorTerminationResult(value: unknown): SupervisorTerminationResult {
  assertFrameSize(value)
  const input = exactRecord(value, ['allExited', 'survivors'])
  if (!Array.isArray(input.survivors)) return invalid()
  return {
    allExited: boolean(input.allExited),
    survivors: input.survivors.map(positiveInteger)
  }
}

function serializedFrame(value: unknown): string {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch {
    return invalid('Terminal protocol frame is not JSON serializable')
  }
  return encoded === undefined
    ? invalid('Terminal protocol frame is not JSON serializable')
    : encoded
}

function assertFrameSize(value: unknown): void {
  if (Buffer.byteLength(serializedFrame(value), 'utf8') > TERMINAL_MAX_FRAME_BYTES) {
    invalid('Terminal protocol frame exceeds 256 KiB')
  }
}

export function parseProtocolLine(line: string): unknown {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > TERMINAL_MAX_FRAME_BYTES) {
    return invalid(normalized ? 'Terminal protocol frame exceeds 256 KiB' : undefined)
  }
  try {
    return JSON.parse(normalized) as unknown
  } catch {
    return invalid('Terminal protocol frame is not valid JSON')
  }
}

export function encodeProtocolFrame(value: unknown): string {
  const encoded = serializedFrame(value)
  if (Buffer.byteLength(encoded, 'utf8') > TERMINAL_MAX_FRAME_BYTES) {
    return invalid('Terminal protocol frame exceeds 256 KiB')
  }
  return `${encoded}\n`
}
