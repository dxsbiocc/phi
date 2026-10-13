import { TextDecoder } from 'node:util'
import type { RpcFrame } from './types'

/** Official OMP 18.10.3 limits, measured in UTF-8 bytes (physical line includes LF). */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024

interface PendingChunks {
  id: string
  count: number
  bytes: number
  next: number
  received: number
  parts: Buffer[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function frame(value: unknown): RpcFrame {
  if (!record(value) || typeof value.type !== 'string' || !value.type) {
    throw new Error('RPC frame must be an object with a type')
  }
  return value as RpcFrame
}

/** Server commands have no chunk decoder; do not send client-side rpc_chunk frames. */
export function encodeRpcCommand(command: Readonly<Record<string, unknown>>): Buffer {
  const json = JSON.stringify(command)
  if (Buffer.byteLength(json, 'utf8') + 1 > MAX_RPC_FRAME_BYTES)
    throw new Error('RPC command exceeds the frame limit')
  return Buffer.from(`${json}\n`, 'utf8')
}

/** Byte-oriented JSONL reader, independent of Bun and the SDK's runtime imports. */
export class RpcFrameCodec {
  private parts: Buffer[] = []
  private lineBytes = 0
  private pending?: PendingChunks
  private negotiated = false

  enableProtocolV2(): void {
    this.negotiated = true
  }

  reset(): void {
    this.parts = []
    this.lineBytes = 0
    this.pending = undefined
    this.negotiated = false
  }

  push(chunk: Uint8Array, onFrame?: (frame: RpcFrame) => void): RpcFrame[] {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const frames: RpcFrame[] = []
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset)
      const end = newline < 0 ? bytes.length : newline
      const length = end - offset
      // An unfinished line still needs room for its terminating LF.
      if (this.lineBytes + length + 1 > MAX_RPC_FRAME_BYTES) {
        throw new Error('RPC physical frame exceeds the frame limit')
      }
      if (length) this.parts.push(Buffer.from(bytes.subarray(offset, end)))
      this.lineBytes += length
      if (newline < 0) break
      const line = Buffer.concat(this.parts, this.lineBytes)
      this.parts = []
      this.lineBytes = 0
      offset = newline + 1
      const text = new TextDecoder('utf-8', { fatal: true }).decode(line).trim()
      if (!text) continue
      const decoded = this.accept(frame(JSON.parse(text)))
      if (decoded) {
        frames.push(decoded)
        onFrame?.(decoded)
      }
    }
    return frames
  }

  finish(): void {
    if (this.lineBytes) throw new Error('RPC output ended with a partial JSONL frame')
    if (this.pending) throw new Error('RPC output ended with an incomplete chunk sequence')
  }

  private accept(value: RpcFrame): RpcFrame | undefined {
    if (value.type !== 'rpc_chunk') {
      if (this.pending) throw new Error('RPC chunk sequence was interrupted')
      return value
    }
    if (!this.negotiated) throw new Error('RPC chunk received before protocol negotiation')
    const { chunkId, index, count, byteLength, data } = value
    if (
      typeof chunkId !== 'string' ||
      !chunkId ||
      chunkId.length > 128 ||
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      count > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
      index >= count ||
      typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < MAX_RPC_FRAME_BYTES ||
      byteLength > MAX_RPC_REASSEMBLED_BYTES
    )
      throw new Error('Invalid RPC chunk metadata')
    if (
      typeof data !== 'string' ||
      !data ||
      data.length > Math.ceil(RPC_CHUNK_PAYLOAD_BYTES / 3) * 4 ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    )
      throw new Error('Invalid RPC chunk base64 data')
    const payload = Buffer.from(data, 'base64')
    if (payload.toString('base64') !== data || payload.length > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new Error('Invalid RPC chunk payload')
    }
    if (!this.pending) {
      if (index !== 0) throw new Error('RPC chunk sequence must start at index zero')
      this.pending = { id: chunkId, count, bytes: byteLength, next: 0, received: 0, parts: [] }
    }
    const pending = this.pending
    if (
      pending.id !== chunkId ||
      pending.count !== count ||
      pending.bytes !== byteLength ||
      pending.next !== index
    ) {
      throw new Error('RPC chunk sequence mismatch')
    }
    pending.parts.push(payload)
    pending.received += payload.length
    pending.next++
    if (pending.received > pending.bytes) throw new Error('RPC chunks exceed their declared length')
    if (pending.next < pending.count) return undefined
    if (pending.received !== pending.bytes) throw new Error('RPC chunk sequence length mismatch')
    this.pending = undefined
    const decoded = frame(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(pending.parts, pending.received)
        )
      )
    )
    if (decoded.type === 'rpc_chunk') throw new Error('Nested RPC chunk frames are invalid')
    return decoded
  }
}
