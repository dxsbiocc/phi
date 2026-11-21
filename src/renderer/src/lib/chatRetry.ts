import type { ChatItem } from '../types'

export function messagesForUserRetry(
  messages: ChatItem[],
  userMessageId: string,
  content?: string
): ChatItem[] {
  const userMessageIndex = userRetryIndex(messages, { id: userMessageId })
  if (userMessageIndex < 0) return messages
  return retryMessagesAtIndex(messages, userMessageIndex, content)
}

export function messagesForUserRetryTarget(
  messages: ChatItem[],
  target: { id?: string; content?: string; imageIds?: string[] }
): ChatItem[] {
  const userMessageIndex = userRetryIndex(messages, target)
  if (userMessageIndex < 0) return messages
  return retryMessagesAtIndex(messages, userMessageIndex, target.content)
}

function retryMessagesAtIndex(
  messages: ChatItem[],
  userMessageIndex: number,
  content?: string
): ChatItem[] {
  const next = messages.slice(0, userMessageIndex + 1)
  const target = next[userMessageIndex]
  if (content !== undefined && target?.role === 'user') {
    next[userMessageIndex] = { ...target, content }
  }
  return next
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
