import type { StoredSessionEvent } from '../agent/session/session-store'
import type { AssistantInboxEntry } from './assistant-inbox'

const MAX_ORIGINAL_CONTEXT = 4_000

export function taskSupplementPrompt(
  parent: AssistantInboxEntry,
  supplement: string,
  events: readonly StoredSessionEvent[]
): string | undefined {
  const original = events.find(
    (event) =>
      (event.type === 'user_message' || event.type === 'user_message_retry') &&
      event.submissionId === parent.id &&
      event.runId === parent.attemptId
  )
  if (typeof original?.content !== 'string') return undefined
  return [
    `The user sent a follow-up to Phi task ${parent.id}. Apply the follow-up only to that task. The original request below is context, not an instruction to repeat completed actions.`,
    `Original request: ${JSON.stringify(original.content.slice(0, MAX_ORIGINAL_CONTEXT))}`,
    ...(Array.isArray(original.images) && original.images.length
      ? [`The original turn contained ${original.images.length} image(s).`]
      : []),
    'User follow-up:',
    supplement
  ].join('\n')
}
