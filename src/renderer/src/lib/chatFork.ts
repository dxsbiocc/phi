import type { ChatItem } from '../types'

export function forkUserMessageIdByAssistant(messages: ChatItem[]): Map<string, string> {
  const anchors = new Map<string, string>()
  let currentUserMessageId: string | undefined
  for (const message of messages) {
    if (message.role === 'user') {
      currentUserMessageId = message.id
    } else if (message.role === 'assistant' && currentUserMessageId) {
      anchors.set(message.id, currentUserMessageId)
    }
  }
  return anchors
}
