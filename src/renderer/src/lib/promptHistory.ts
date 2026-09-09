import type { ChatItem, ChatMessage } from '../types'

const PROMPT_HISTORY_LIMIT = 100

export type PromptHistoryDirection = 'previous' | 'next'

export function promptHistoryFromMessages(messages: ChatItem[]): string[] {
  return messages
    .filter((message): message is ChatMessage => message.role === 'user')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .slice(-PROMPT_HISTORY_LIMIT)
}

export function nextPromptHistoryCursor(
  historyLength: number,
  cursor: number | null,
  direction: PromptHistoryDirection
): number | null {
  if (historyLength <= 0) return null
  if (direction === 'previous') {
    return cursor === null ? historyLength - 1 : Math.max(0, cursor - 1)
  }
  if (cursor === null) return null
  return cursor >= historyLength - 1 ? null : cursor + 1
}
