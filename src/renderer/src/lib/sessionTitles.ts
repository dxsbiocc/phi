import type { ChatItem, SessionSummary } from '../types'

const MAX_SESSION_TITLE_CHARS = 60

export function truncateSessionTitle(title: string, maxLength = MAX_SESSION_TITLE_CHARS): string {
  const normalized = title.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}

export function sessionDisplayTitle(session: SessionSummary): string {
  return truncateSessionTitle(session.name || session.firstMessage || '新对话')
}

export function titleFromMessages(messages: ChatItem[]): string | null {
  const firstUserMessage = messages.find(
    (message) => message.role === 'user' && message.content.trim().length > 0
  )
  return firstUserMessage && firstUserMessage.role === 'user'
    ? truncateSessionTitle(firstUserMessage.content)
    : null
}
