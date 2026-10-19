import type { PromptImageInput } from '../../../../../shared/promptImageTypes'
import type { PromptTarget } from '../../../lib/sessionTypes'

/**
 * Chat prompt backlog.
 *
 * A prompt typed while a run is in flight is not dropped: it is parked under the
 * draft key it was typed in and replayed when the session goes idle. The
 * transforms below are the whole of that semantics — every one takes the current
 * backlog and returns the next one, so the caller only owns the `useState`.
 *
 * They return the same object when nothing changed, which lets React bail out of
 * a render and keeps "remove an id that is already gone" a no-op.
 */

/** Options the send pipeline needs to replay a queued prompt faithfully. */
export type SendPromptOptions = {
  appendUserMessage?: boolean
  retryUserMessageId?: string
  suppressUserMessageEvent?: boolean
  images?: PromptImageInput[]
  planMode?: boolean
}

export type QueuedPrompt = {
  id: string
  text: string
  target: PromptTarget
  sendOptions?: SendPromptOptions
}

/** Prompts waiting behind a run, keyed by the draft key they were typed under. */
export type QueuedPromptsBySession = Record<string, QueuedPrompt[]>

export function appendQueuedPrompt(
  queue: QueuedPromptsBySession,
  key: string,
  prompt: QueuedPrompt
): QueuedPromptsBySession {
  const current = queue[key] ?? []
  return { ...queue, [key]: [...current, prompt] }
}

export function dropQueuedPrompt(
  queue: QueuedPromptsBySession,
  key: string,
  id: string
): QueuedPromptsBySession {
  const current = queue[key] ?? []
  const next = current.filter((item) => item.id !== id)
  if (next.length === current.length) return queue
  const updated = { ...queue }
  if (next.length > 0) updated[key] = next
  else delete updated[key]
  return updated
}

/**
 * Removes the head prompt only when it is still `id`.
 *
 * The queue drains asynchronously, so the session may have changed (or the user
 * may have removed the prompt) between the decision and the dequeue. Matching the
 * id keeps that race from dropping someone else's prompt.
 */
export function shiftQueuedPrompt(
  queue: QueuedPromptsBySession,
  key: string,
  id: string
): QueuedPromptsBySession {
  const current = queue[key] ?? []
  if (current[0]?.id !== id) return queue
  const remaining = current.slice(1)
  const updated = { ...queue }
  if (remaining.length > 0) updated[key] = remaining
  else delete updated[key]
  return updated
}

/**
 * Re-homes the backlog when a fresh chat materializes into a stable session.
 *
 * Prompts typed before the session existed hold a provisional target. They keep
 * their ids and text, take the real session identity, and merge behind whatever
 * is already queued for that session.
 */
export function retargetQueuedPrompts(
  queue: QueuedPromptsBySession,
  fromKey: string,
  toKey: string,
  target: PromptTarget
): QueuedPromptsBySession {
  const current = queue[fromKey] ?? []
  if (current.length === 0) return queue
  const updated = { ...queue }
  delete updated[fromKey]
  updated[toKey] = [
    ...(updated[toKey] ?? []),
    ...current.map((item) => ({ ...item, target: { ...item.target, ...target } }))
  ]
  return updated
}
