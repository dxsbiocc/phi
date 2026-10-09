import type { RemoteStdioProcess } from '../wrappers/remote-ssh-session'
import { WorkspaceHostError } from './types'

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024
const DOMAIN_ERROR_CODES = new Set(['HASH_MISMATCH', 'INVALID_ARGUMENT', 'PATH_OUTSIDE_ROOT'])

interface RpcError {
  code?: unknown
  message?: unknown
  data?: unknown
}

interface RpcResponse {
  jsonrpc?: unknown
  id?: unknown
  result?: unknown
  error?: RpcError
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup?: () => void
}

export interface HelperRpcRequestOptions {
  signal?: AbortSignal
  cancellable?: boolean
}

export interface HelperRpcClientOptions {
  maxFrameBytes?: number
  onDisconnect?: (error: Error) => void
}

function responseError(error: RpcError | undefined): Error {
  const message =
    typeof error?.message === 'string' ? error.message : 'remote helper request failed'
  const data =
    typeof error?.data === 'object' && error.data !== null
      ? (error.data as Record<string, unknown>)
      : undefined
  const code = data?.code
  if (typeof code === 'string' && DOMAIN_ERROR_CODES.has(code)) {
    return new WorkspaceHostError(message, code as WorkspaceHostError['code'])
  }
  return new Error(message)
}

function encodeFrame(value: unknown, maxFrameBytes: number): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  if (payload.byteLength > maxFrameBytes)
    throw new Error('remote helper request frame is too large')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.byteLength)
  return Buffer.concat([header, payload])
}

export class HelperRpcClient {
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly maxFrameBytes: number
  private closed = false

  constructor(
    private readonly process: RemoteStdioProcess,
    private readonly options: HelperRpcClientOptions = {}
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    process.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    process.stdout.once('error', (error) => this.fail(error))
    process.stdin.once('error', (error) => this.fail(error))
    process.stderr.on('data', () => undefined)
    void process.closed.then(
      ({ code, signal }) =>
        this.fail(new Error(`remote helper exited (${signal ?? code ?? 'unknown'})`)),
      (error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error)))
    )
  }

  request<T>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: HelperRpcRequestOptions = {}
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('remote helper connection is closed'))
    const id = this.nextId
    this.nextId += 1
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      })
      try {
        this.process.stdin.write(
          encodeFrame({ jsonrpc: '2.0', id, method, params }, this.maxFrameBytes)
        )
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
    if (options.signal && options.cancellable) {
      const pending = this.pending.get(id)
      if (pending) pending.cleanup = this.bindCancellation(id, options.signal)
    }
    return promise
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.rejectPending(new Error('remote helper connection is closed'))
    await this.process.close()
  }

  private bindCancellation(id: number, signal: AbortSignal): () => void {
    const cancel = (): void => {
      if (!this.pending.has(id) || this.closed) return
      void this.request('exec.cancel', { requestId: id }).catch(() => undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    return () => signal.removeEventListener('abort', cancel)
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      while (this.buffer.byteLength >= 4) {
        const length = this.buffer.readUInt32BE(0)
        if (length > this.maxFrameBytes)
          throw new Error('remote helper response frame is too large')
        if (this.buffer.byteLength < length + 4) return
        const payload = this.buffer.subarray(4, length + 4)
        this.buffer = this.buffer.subarray(length + 4)
        this.handle(JSON.parse(payload.toString('utf8')) as RpcResponse)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handle(response: RpcResponse): void {
    if (response.jsonrpc !== '2.0' || typeof response.id !== 'number') {
      throw new Error('remote helper returned an invalid JSON-RPC response')
    }
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    pending.cleanup?.()
    if (response.error) pending.reject(responseError(response.error))
    else pending.resolve(response.result)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(error)
    this.options.onDisconnect?.(error)
    void this.process.close().catch(() => undefined)
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      request.cleanup?.()
      request.reject(error)
    }
    this.pending.clear()
  }
}
