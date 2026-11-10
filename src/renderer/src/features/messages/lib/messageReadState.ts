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

/**
 * Marks one message read while dropping ids that no longer match a message.
 *
 * The just-read id is always kept, even if the caller's current message list is
 * stale, so a click is never lost. Everything else must still exist, which keeps
 * the stored list bounded to the messages the user can actually see.
 */
export function markMessageRead(
  readIds: ReadonlySet<string>,
  messageIds: Iterable<string>,
  messageId: string
): Set<string> {
  const current = new Set(messageIds)
  const next = new Set<string>()
  for (const id of readIds) {
    if (current.has(id)) next.add(id)
  }
  next.add(messageId)
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
