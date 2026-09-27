import type { RemoteSshSession } from './remote-ssh-session'
import { MAX_REMOTE_LOG_RAW_BYTES, readRemoteFileChunk } from './remote-ssh-log'

export const MAX_REMOTE_LOG_POLL_BYTES = 256 * 1024

export interface RemoteLogCursor {
  /** Whole-file byte coordinate, never a decoded string length. */
  offset: number
  identity?: string
  /** At most three trailing bytes of a UTF-8 character, persisted across reconnects. */
  pendingUtf8?: string
}

export interface RemoteLogDelta {
  text: string
  cursor: RemoteLogCursor
  diagnostics: string[]
  bytesRead: number
  missing: boolean
}

function pendingBytes(encoded: string | undefined): Buffer {
  if (!encoded) return Buffer.alloc(0)
  if (!/^[A-Za-z0-9+/]{2,4}={0,2}$/.test(encoded)) {
    throw new Error('远程日志 UTF-8 续读状态无效')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > 3) throw new Error('远程日志 UTF-8 续读状态过长')
  return bytes
}

/** Keep only an incomplete UTF-8 suffix; malformed complete bytes decode as replacement glyphs. */
function completeUtf8Length(bytes: Buffer): number {
  if (bytes.length === 0) return 0
  let lead = bytes.length - 1
  while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead -= 1
  if (lead < 0) return bytes.length
  const head = bytes[lead]
  const expected =
    head >= 0xc2 && head <= 0xdf
      ? 2
      : head >= 0xe0 && head <= 0xef
        ? 3
        : head >= 0xf0 && head <= 0xf4
          ? 4
          : 1
  return bytes.length - lead < expected ? lead : bytes.length
}

/** Adapted from DSH OutputCollector.readFrom: byte offsets advance by consumed bytes. */
export async function readRemoteLogDelta(
  session: RemoteSshSession,
  path: string,
  cursor: RemoteLogCursor,
  maxBytes = MAX_REMOTE_LOG_POLL_BYTES
): Promise<RemoteLogDelta> {
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    throw new Error('远程日志持久偏移无效')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REMOTE_LOG_POLL_BYTES) {
    throw new Error('远程日志轮询字节上限无效')
  }
  let offset = cursor.offset
  let identity = cursor.identity
  let pending = pendingBytes(cursor.pendingUtf8)
  let remaining = maxBytes
  let read = 0
  let missing = false
  const text: string[] = []
  const diagnostics: string[] = []
  while (remaining > 0) {
    const limit = Math.min(remaining, MAX_REMOTE_LOG_RAW_BYTES)
    const page = await readRemoteFileChunk(session, path, { offset, maxBytes: limit, identity })
    if (page.missing) {
      missing = true
      break
    }
    if (page.reset) {
      pending = Buffer.alloc(0)
      diagnostics.push(
        page.reset === 'rotated'
          ? '远程日志文件已轮转，已从新文件开头继续读取。'
          : `远程日志偏移 ${offset} 超出当前文件大小 ${page.size}，已从开头继续读取。`
      )
    }
    offset = page.nextOffset
    identity = page.identity
    const joined = Buffer.concat([pending, page.bytes])
    const complete = completeUtf8Length(joined)
    if (complete > 0) text.push(joined.subarray(0, complete).toString('utf8'))
    pending = joined.subarray(complete)
    read += page.bytes.length
    remaining -= page.bytes.length
    if (page.bytes.length < limit || offset >= page.size) break
  }
  return {
    text: text.join(''),
    cursor: {
      offset,
      ...(identity ? { identity } : {}),
      ...(pending.length ? { pendingUtf8: pending.toString('base64') } : {})
    },
    diagnostics,
    bytesRead: read,
    missing
  }
}

/** Older controller APIs ask only for the latest tail; a single bounded page suffices. */
export async function readRemoteLogTail(session: RemoteSshSession, path: string): Promise<string> {
  const page = await readRemoteFileChunk(session, path, {
    offset: 0,
    maxBytes: MAX_REMOTE_LOG_RAW_BYTES,
    tail: true
  })
  if (page.missing) return ''
  let bytes = page.bytes
  while (bytes.length > 0 && (bytes[0] & 0xc0) === 0x80) bytes = bytes.subarray(1)
  return bytes.toString('utf8')
}
