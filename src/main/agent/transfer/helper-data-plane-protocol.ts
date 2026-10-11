import type { Writable } from 'node:stream'

import type { RemoteStdioProcess } from '../wrappers/remote-ssh-session'

const MAX_FRAME_BYTES = 64 * 1024 * 1024
const BINARY_MAGIC = Buffer.from('PHDP')
const BINARY_VERSION = 1
const BINARY_FIXED_HEADER_BYTES = 52
const MAX_TRANSFER_ID_BYTES = 128
export const HELPER_DATA_PLANE_CHUNK_BYTES = 8 * 1024 * 1024

export enum HelperBinaryFrameType {
  UploadData = 1,
  UploadAck = 2,
  DownloadRequest = 3,
  DownloadData = 4,
  DownloadAck = 5,
  Error = 6
}

export type HelperBinaryFrame = Readonly<{
  type: HelperBinaryFrameType
  transferId: string
  offset: number
  length: number
  sha256: Buffer
  data: Buffer
}>

export type HelperDataPlaneProtocolClientOptions = Readonly<{
  requestTimeoutMs?: number
}>

export type HelperDataPlaneRequestOptions = Readonly<{
  signal?: AbortSignal
}>

type PendingRequest = Readonly<{
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}>

type PendingBinary = Readonly<{
  expectedType: HelperBinaryFrameType
  resolve: (frame: HelperBinaryFrame) => void
  reject: (error: Error) => void
  cleanup: () => void
}>

type RpcResponse = Readonly<{
  jsonrpc?: unknown
  id?: unknown
  result?: unknown
  error?: Readonly<{ code?: unknown; message?: unknown; data?: unknown }>
}>

export class HelperProtocolError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
    readonly domainCode?: string
  ) {
    super(message)
    this.name = 'HelperProtocolError'
  }
}

function disconnectError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new HelperProtocolError('remote helper connection is closed')
}

function waitForDrain(stream: Writable, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(disconnectError(signal.reason))
  if (stream.destroyed) {
    return Promise.reject(new HelperProtocolError('remote helper input stream closed before drain'))
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener('drain', drained)
      stream.removeListener('error', failed)
      stream.removeListener('close', closed)
      signal.removeEventListener('abort', aborted)
    }
    const drained = (): void => {
      cleanup()
      resolve()
    }
    const failed = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const closed = (): void => {
      cleanup()
      reject(new HelperProtocolError('remote helper input stream closed before drain'))
    }
    const aborted = (): void => {
      cleanup()
      reject(disconnectError(signal.reason))
    }
    stream.once('drain', drained)
    stream.once('error', failed)
    stream.once('close', closed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

async function writeFrame(
  stream: Writable,
  payload: Buffer,
  disconnectSignal: AbortSignal
): Promise<void> {
  if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME_BYTES) {
    throw new HelperProtocolError('remote helper request frame is invalid')
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.byteLength)
  if (!stream.write(header)) await waitForDrain(stream, disconnectSignal)
  if (!stream.write(payload)) await waitForDrain(stream, disconnectSignal)
}

function binaryKey(transferId: string, offset: number): string {
  return `${transferId}\0${offset}`
}

function checkedOffset(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HelperProtocolError('helper binary frame offset is invalid')
  }
  return value
}

function checkedLength(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > HELPER_DATA_PLANE_CHUNK_BYTES) {
    throw new HelperProtocolError('helper binary frame length is invalid')
  }
  return value
}

export function encodeHelperBinaryFrame(frame: HelperBinaryFrame): Buffer {
  const transferId = Buffer.from(frame.transferId, 'utf8')
  if (
    transferId.byteLength === 0 ||
    transferId.byteLength > MAX_TRANSFER_ID_BYTES ||
    transferId.toString('utf8') !== frame.transferId
  ) {
    throw new HelperProtocolError('helper binary frame transfer id is invalid')
  }
  const offset = checkedOffset(frame.offset)
  const length = checkedLength(frame.length)
  if (frame.sha256.byteLength !== 32) {
    throw new HelperProtocolError('helper binary frame SHA-256 is invalid')
  }
  const carriesData =
    frame.type === HelperBinaryFrameType.UploadData ||
    frame.type === HelperBinaryFrameType.DownloadData ||
    frame.type === HelperBinaryFrameType.Error
  if (
    (carriesData && frame.data.byteLength !== length) ||
    (!carriesData && frame.data.byteLength)
  ) {
    throw new HelperProtocolError('helper binary frame payload length is invalid')
  }
  const payload = Buffer.allocUnsafe(
    BINARY_FIXED_HEADER_BYTES + transferId.byteLength + frame.data.byteLength
  )
  BINARY_MAGIC.copy(payload, 0)
  payload[4] = BINARY_VERSION
  payload[5] = frame.type
  payload.writeUInt16BE(transferId.byteLength, 6)
  payload.writeBigUInt64BE(BigInt(offset), 8)
  payload.writeUInt32BE(length, 16)
  frame.sha256.copy(payload, 20)
  transferId.copy(payload, BINARY_FIXED_HEADER_BYTES)
  frame.data.copy(payload, BINARY_FIXED_HEADER_BYTES + transferId.byteLength)
  return payload
}

export function decodeHelperBinaryFrame(payload: Buffer): HelperBinaryFrame {
  if (
    payload.byteLength < BINARY_FIXED_HEADER_BYTES ||
    !payload.subarray(0, 4).equals(BINARY_MAGIC)
  ) {
    throw new HelperProtocolError('remote helper returned an invalid binary frame')
  }
  if (payload[4] !== BINARY_VERSION) {
    throw new HelperProtocolError('remote helper returned an unsupported binary frame version')
  }
  const type = payload[5]
  if (!Object.values(HelperBinaryFrameType).includes(type as HelperBinaryFrameType)) {
    throw new HelperProtocolError('remote helper returned an invalid binary frame type')
  }
  const transferIdBytes = payload.readUInt16BE(6)
  const offsetValue = payload.readBigUInt64BE(8)
  if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HelperProtocolError('remote helper returned an unsafe binary frame offset')
  }
  const offset = checkedOffset(Number(offsetValue))
  const length = checkedLength(payload.readUInt32BE(16))
  const sha256 = Buffer.from(payload.subarray(20, 52))
  const idEnd = BINARY_FIXED_HEADER_BYTES + transferIdBytes
  if (
    transferIdBytes === 0 ||
    transferIdBytes > MAX_TRANSFER_ID_BYTES ||
    idEnd > payload.byteLength
  ) {
    throw new HelperProtocolError('remote helper returned an invalid binary transfer id')
  }
  const transferIdBuffer = payload.subarray(BINARY_FIXED_HEADER_BYTES, idEnd)
  const transferId = transferIdBuffer.toString('utf8')
  if (Buffer.from(transferId).byteLength !== transferIdBuffer.byteLength) {
    throw new HelperProtocolError('remote helper returned an invalid binary transfer id')
  }
  const data = Buffer.from(payload.subarray(idEnd))
  const carriesData =
    type === HelperBinaryFrameType.UploadData ||
    type === HelperBinaryFrameType.DownloadData ||
    type === HelperBinaryFrameType.Error
  if ((carriesData && data.byteLength !== length) || (!carriesData && data.byteLength !== 0)) {
    throw new HelperProtocolError('remote helper returned a broken binary frame')
  }
  return { type: type as HelperBinaryFrameType, transferId, offset, length, sha256, data }
}

export class HelperDataPlaneProtocolClient {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly pendingBinary = new Map<string, PendingBinary>()
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private closed = false
  private writes: Promise<void> = Promise.resolve()
  private readonly disconnectController = new AbortController()

  constructor(
    private readonly process: RemoteStdioProcess,
    private readonly options: HelperDataPlaneProtocolClientOptions = {}
  ) {
    process.stdout.on('data', (chunk: Buffer | string) =>
      this.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    )
    process.stdout.once('error', (error) => this.fail(error))
    process.stdin.once('error', (error) => this.fail(error))
    process.stderr.on('data', () => undefined)
    void process.closed.then(
      ({ code, signal }) =>
        this.fail(new HelperProtocolError(`remote helper exited (${signal ?? code ?? 'unknown'})`)),
      (error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error)))
    )
  }

  async request<T>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    requestOptions: HelperDataPlaneRequestOptions = {}
  ): Promise<T> {
    if (this.closed) throw new HelperProtocolError('remote helper connection is closed')
    const id = this.nextId++
    const abort = (): void => {
      const error = new Error('Transfer cancelled')
      error.name = 'AbortError'
      this.fail(error)
    }
    const promise = new Promise<T>((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? 30 * 60 * 1000
      const timeout = setTimeout(() => {
        this.fail(new HelperProtocolError(`remote helper request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {
          clearTimeout(timeout)
          requestOptions.signal?.removeEventListener('abort', abort)
        }
      })
    })
    void promise.catch(() => undefined)
    requestOptions.signal?.addEventListener('abort', abort, { once: true })
    if (requestOptions.signal?.aborted) abort()
    try {
      await this.write(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })))
    } catch (error) {
      this.pending.get(id)?.cleanup()
      this.pending.delete(id)
      throw error
    }
    return promise
  }

  exchangeBinary(
    frame: HelperBinaryFrame,
    expectedType: HelperBinaryFrameType
  ): Promise<HelperBinaryFrame> {
    if (this.closed) {
      return Promise.reject(new HelperProtocolError('remote helper connection is closed'))
    }
    const key = binaryKey(frame.transferId, frame.offset)
    if (this.pendingBinary.has(key)) {
      return Promise.reject(
        new HelperProtocolError('duplicate helper binary frame offset is pending')
      )
    }
    const response = new Promise<HelperBinaryFrame>((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? 30 * 60 * 1000
      const timeout = setTimeout(() => {
        this.fail(
          new HelperProtocolError(`remote helper binary frame timed out after ${timeoutMs}ms`)
        )
      }, timeoutMs)
      this.pendingBinary.set(key, {
        expectedType,
        resolve,
        reject,
        cleanup: () => clearTimeout(timeout)
      })
    })
    void response.catch(() => undefined)
    void this.write(encodeHelperBinaryFrame(frame)).catch((error: unknown) => {
      const pending = this.pendingBinary.get(key)
      if (!pending) return
      this.pendingBinary.delete(key)
      pending.cleanup()
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    })
    return response
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const error = new HelperProtocolError('remote helper connection is closed')
    this.disconnectController.abort(error)
    this.rejectPending(error)
    await this.process.close()
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      while (this.buffer.byteLength >= 4) {
        const length = this.buffer.readUInt32BE(0)
        if (length === 0 || length > MAX_FRAME_BYTES) {
          throw new HelperProtocolError('remote helper response frame is invalid')
        }
        if (this.buffer.byteLength < length + 4) return
        const payload = this.buffer.subarray(4, length + 4)
        this.buffer = this.buffer.subarray(length + 4)
        if (payload.subarray(0, 4).equals(BINARY_MAGIC)) {
          this.handleBinary(decodeHelperBinaryFrame(payload))
        } else {
          this.handle(JSON.parse(payload.toString('utf8')) as RpcResponse)
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleBinary(frame: HelperBinaryFrame): void {
    const key = binaryKey(frame.transferId, frame.offset)
    const pending = this.pendingBinary.get(key)
    if (!pending) {
      throw new HelperProtocolError('remote helper returned an unexpected binary frame')
    }
    this.pendingBinary.delete(key)
    pending.cleanup()
    if (frame.type === HelperBinaryFrameType.Error) {
      const [code, ...message] = frame.data.toString('utf8').split('\n')
      pending.reject(
        new HelperProtocolError(
          message.join('\n') || code || 'remote helper transfer failed',
          undefined,
          code || undefined
        )
      )
      return
    }
    if (frame.type !== pending.expectedType) {
      pending.reject(
        new HelperProtocolError('remote helper returned an unexpected binary frame type')
      )
      return
    }
    pending.resolve(frame)
  }

  private handle(response: RpcResponse): void {
    if (response.jsonrpc !== '2.0' || typeof response.id !== 'number') {
      throw new HelperProtocolError('remote helper returned an invalid JSON-RPC response')
    }
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    pending.cleanup()
    if (!response.error) {
      pending.resolve(response.result)
      return
    }
    const message =
      typeof response.error.message === 'string'
        ? response.error.message
        : 'remote helper request failed'
    const data =
      typeof response.error.data === 'object' && response.error.data !== null
        ? (response.error.data as Record<string, unknown>)
        : undefined
    pending.reject(
      new HelperProtocolError(
        message,
        typeof response.error.code === 'number' ? response.error.code : undefined,
        typeof data?.code === 'string' ? data.code : undefined
      )
    )
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.disconnectController.abort(error)
    this.rejectPending(error)
    void this.process.close().catch(() => undefined)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
    for (const pending of this.pendingBinary.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pendingBinary.clear()
  }

  private write(payload: Buffer): Promise<void> {
    const operation = this.writes.then(() =>
      writeFrame(this.process.stdin, payload, this.disconnectController.signal)
    )
    this.writes = operation.catch(() => undefined)
    return operation
  }
}
