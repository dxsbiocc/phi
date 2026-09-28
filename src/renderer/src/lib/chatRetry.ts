import type { ChatItem } from '../types'

export function messagesForUserRetry(messages: ChatItem[], userMessageId: string): ChatItem[] {
  const userMessageIndex = userRetryIndex(messages, { id: userMessageId })
  if (userMessageIndex < 0) return messages
  return messages.slice(0, userMessageIndex + 1)
}

export function messagesForUserRetryTarget(
  messages: ChatItem[],
  target: { id?: string; content?: string; imageIds?: string[] }
): ChatItem[] {
  const userMessageIndex = userRetryIndex(messages, target)
  if (userMessageIndex < 0) return messages
  return messages.slice(0, userMessageIndex + 1)
}

function userRetryIndex(
  messages: ChatItem[],
  target: { id?: string; content?: string; imageIds?: string[] }
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    if (target.id && message.id === target.id) return index
    if (target.content && message.content === target.content) return index
    if (
      target.imageIds?.length &&
      message.images?.length === target.imageIds.length &&
      message.images.every((image, imageIndex) =>
        'id' in image ? image.id === target.imageIds?.[imageIndex] : false
      )
    ) {
      return index
    }
  }
  return -1
}
