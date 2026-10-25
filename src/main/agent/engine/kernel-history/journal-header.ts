import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { TextDecoder } from 'node:util'

const MAX_HEADER_BYTES = 1024 * 1024

export interface OmpJournalHeader {
  readonly type: 'session'
  readonly version?: number
  readonly id: string
  readonly timestamp: string
  readonly cwd: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseLine(bytes: Buffer, start: number): { value: Record<string, unknown>; next: number } {
  const end = bytes.indexOf(0x0a, start)
  if (end < 0) throw new Error('OMP journal header is incomplete')
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end))
  const value = record(JSON.parse(decoded))
  if (!value) throw new Error('OMP journal header is invalid')
  return { value, next: end + 1 }
}

export function parseOmpJournalHeader(bytes: Buffer): OmpJournalHeader {
  const first = parseLine(bytes, 0)
  const candidate = first.value.type === 'title' ? parseLine(bytes, first.next).value : first.value
  if (
    candidate.type !== 'session' ||
    typeof candidate.id !== 'string' ||
    !candidate.id ||
    typeof candidate.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(candidate.timestamp)) ||
    typeof candidate.cwd !== 'string' ||
    !isAbsolute(candidate.cwd) ||
    (candidate.version !== undefined &&
      (!Number.isSafeInteger(candidate.version) || (candidate.version as number) < 1))
  ) {
    throw new Error('OMP journal session header is invalid')
  }
  return {
    type: 'session',
    ...(candidate.version === undefined ? {} : { version: candidate.version as number }),
    id: candidate.id,
    timestamp: candidate.timestamp,
    cwd: candidate.cwd
  }
}

export async function readOmpJournalHeader(path: string): Promise<OmpJournalHeader> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return parseOmpJournalHeader(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
