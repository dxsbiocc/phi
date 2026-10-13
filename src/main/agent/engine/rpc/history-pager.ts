import type { RpcConnection } from './connection'
import { RpcByteLimitError, RpcRequestError } from './errors'
import type { RpcControlChannel } from './types'

export type RemoteHistoryErrorCode =
  'HISTORY_INVALID' | 'HISTORY_CHANGED' | 'HISTORY_LIMIT' | 'SESSION_BUSY' | 'GENERATION_REVOKED'

export class RemoteHistoryError extends Error {
  constructor(
    readonly code: RemoteHistoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RemoteHistoryError'
  }
}

/** SDK identity; Phi's desktop session ID is deliberately a separate field. */
export interface RemoteHistoryCheckpoint {
  readonly phiSessionId: string
  readonly ompSessionId: string
  readonly journalPath: string
  readonly projectRoot: string
  readonly generation: number
  readonly leafId: string | null
  readonly messageCount: number
}

export interface RemoteHistoryPagerOptions {
  readonly connection: Pick<RpcConnection, 'request' | 'bindControl'>
  readonly control: RpcControlChannel
  readonly checkpoint: RemoteHistoryCheckpoint
  /** Reads the actual attached manager, not a desktop path or a fabricated get_state.cwd. */
  readonly readCheckpoint: (signal: AbortSignal) => Promise<RemoteHistoryCheckpoint>
  readonly signal: AbortSignal
  readonly pageSize?: number
  readonly maxBytes?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function sameHistoryCheckpoint(
  a: RemoteHistoryCheckpoint,
  b: RemoteHistoryCheckpoint
): boolean {
  return (
    a.phiSessionId === b.phiSessionId &&
    a.ompSessionId === b.ompSessionId &&
    a.journalPath === b.journalPath &&
    a.projectRoot === b.projectRoot &&
    a.generation === b.generation &&
    a.leafId === b.leafId &&
    a.messageCount === b.messageCount
  )
}

function cursorOffset(cursor: string, checkpoint: RemoteHistoryCheckpoint): number {
  if (cursor.length === 0 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new RemoteHistoryError('HISTORY_INVALID', 'Invalid history cursor')
  const bytes = Buffer.from(cursor, 'base64url')
  let payload: unknown
  try {
    if (bytes.toString('base64url') !== cursor) throw new Error('Noncanonical cursor')
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new RemoteHistoryError('HISTORY_INVALID', 'Invalid history cursor encoding')
  }
  if (
    !record(payload) ||
    payload.version !== 1 ||
    payload.sessionId !== checkpoint.ompSessionId ||
    payload.leafId !== checkpoint.leafId ||
    payload.messageCount !== checkpoint.messageCount ||
    !Number.isSafeInteger(payload.offset) ||
    (payload.offset as number) < 1 ||
    (payload.offset as number) >= checkpoint.messageCount
  )
    throw new RemoteHistoryError(
      'HISTORY_CHANGED',
      'History cursor does not describe the verified snapshot'
    )
  return payload.offset as number
}

/** Races cancellation without leaving rejected late operations unobserved. */
export async function withRemoteSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller already created this operation; cancellation must still observe
    // its eventual failure without changing the cancellation result.
    void operation.catch(() => undefined)
    throw signal.reason
  }
  let revoke!: () => void
  const aborted = new Promise<never>((_, reject) => {
    revoke = () => reject(signal.reason)
    signal.addEventListener('abort', revoke, { once: true })
    if (signal.aborted) revoke()
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', revoke)
  }
}

/** Official 18.10.3 get_messages_page only. Partial aggregates never escape a failed snapshot. */
export async function readRemoteHistory(
  options: RemoteHistoryPagerOptions
): Promise<readonly unknown[]> {
  const { connection, control, checkpoint } = options
  const controller = new AbortController()
  const revoked = (): void =>
    controller.abort(new RemoteHistoryError('GENERATION_REVOKED', 'History generation revoked'))
  for (const signal of [options.signal, control.signal]) {
    signal.addEventListener('abort', revoked, { once: true })
    if (signal.aborted) revoked()
  }
  const assertActive = (): void => {
    if (
      controller.signal.aborted ||
      connection.bindControl().generation !== control.generation ||
      checkpoint.generation !== control.generation
    )
      throw new RemoteHistoryError('GENERATION_REVOKED', 'History generation revoked')
  }
  const pageSize = options.pageSize ?? 100
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  try {
    assertActive()
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 256 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(checkpoint.messageCount) ||
      checkpoint.messageCount < 0
    )
      throw new RemoteHistoryError('HISTORY_INVALID', 'Invalid history page bounds')
    if (maxBytes < 2)
      throw new RemoteHistoryError('HISTORY_LIMIT', 'History exceeds supported byte limit')
    const verify = async (): Promise<void> => {
      assertActive()
      const current = await withRemoteSignal(
        options.readCheckpoint(controller.signal),
        controller.signal
      )
      assertActive()
      if (!sameHistoryCheckpoint(checkpoint, current))
        throw new RemoteHistoryError('HISTORY_CHANGED', 'History changed during paging')
    }
    await verify()
    const messages: unknown[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    let bytes = 2
    do {
      assertActive()
      const page = await withRemoteSignal(
        connection.request<unknown>({
          type: 'get_messages_page',
          limit: pageSize,
          ...(cursor ? { cursor } : {})
        }),
        controller.signal
      )
      assertActive()
      if (
        !record(page) ||
        !Array.isArray(page.messages) ||
        page.totalMessages !== checkpoint.messageCount ||
        page.messages.length > pageSize ||
        page.messages.some((message) => !record(message))
      )
        throw new RemoteHistoryError('HISTORY_INVALID', 'Invalid history page')
      if (messages.length + page.messages.length > checkpoint.messageCount)
        throw new RemoteHistoryError('HISTORY_INVALID', 'History page exceeds verified count')
      for (const message of page.messages) {
        bytes += Buffer.byteLength(JSON.stringify(message), 'utf8') + (messages.length ? 1 : 0)
        if (bytes > maxBytes)
          throw new RemoteHistoryError('HISTORY_LIMIT', 'History exceeds supported byte limit')
        messages.push(message)
      }
      if (page.nextCursor !== undefined) {
        if (
          typeof page.nextCursor !== 'string' ||
          !page.messages.length ||
          cursors.has(page.nextCursor)
        )
          throw new RemoteHistoryError('HISTORY_INVALID', 'History cursor did not advance')
        if (cursorOffset(page.nextCursor, checkpoint) !== messages.length)
          throw new RemoteHistoryError(
            'HISTORY_INVALID',
            'History cursor offset did not advance exactly'
          )
        cursors.add(page.nextCursor)
        cursor = page.nextCursor
      } else cursor = undefined
    } while (cursor !== undefined)
    if (messages.length !== checkpoint.messageCount)
      throw new RemoteHistoryError('HISTORY_INVALID', 'History ended before the verified count')
    await verify()
    return Object.freeze(messages)
  } catch (error) {
    if (error instanceof RemoteHistoryError) throw error
    if (error instanceof RpcRequestError && error.code === 'session_busy')
      throw new RemoteHistoryError('SESSION_BUSY', 'Session is changing', { cause: error })
    if (error instanceof RpcRequestError && error.code === 'stale_cursor')
      throw new RemoteHistoryError('HISTORY_CHANGED', 'History cursor is stale', { cause: error })
    if (error instanceof RpcByteLimitError && error.scope === 'reassembled-frame')
      throw new RemoteHistoryError('HISTORY_LIMIT', 'History frame exceeds supported byte limit', {
        cause: error
      })
    throw error
  } finally {
    for (const signal of [options.signal, control.signal])
      signal.removeEventListener('abort', revoked)
  }
}
