export const MESSAGE_READ_STORAGE_KEY = 'phi.messages-read.v1'

export type MessageReadStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): MessageReadStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** A malformed or unavailable store is treated as empty, never as an error. */
export function readMessageReadIds(storage?: MessageReadStorage | null): Set<string> {
  try {
    const target = storage === undefined ? browserStorage() : storage
    const raw = target?.getItem(MESSAGE_READ_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

/** Storage failures leave the in-memory read state working for this session. */
export function writeMessageReadIds(
  ids: Iterable<string>,
  storage?: MessageReadStorage | null
): void {
  try {
    const target = storage === undefined ? browserStorage() : storage
    target?.setItem(MESSAGE_READ_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Messages simply return as unread after a restart.
  }
}

export function markMessagesRead(
  readIds: ReadonlySet<string>,
  messageIds: Iterable<string>
): Set<string> {
  const next = new Set(readIds)
  for (const id of messageIds) next.add(id)
  return next
}

export function unreadMessageCount(
  messageIds: Iterable<string>,
  readIds: ReadonlySet<string>
): number {
  let count = 0
  for (const id of messageIds) {
    if (!readIds.has(id)) count += 1
  }
  return count
}
