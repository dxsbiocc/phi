import { navigationCopy } from './navigationCopy'
import type { ChatItem, ChatMessage, SessionSummary } from '../types'
import { messageContentTitleText } from '../../../shared/sessionTitle'

const MAX_SESSION_TITLE_CHARS = 60

export function truncateSessionTitle(title: string, maxLength = MAX_SESSION_TITLE_CHARS): string {
  const normalized = title.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}

export function sessionDisplayTitle(session: SessionSummary): string {
  const title =
    messageContentTitleText(session.name) ||
    messageContentTitleText(session.firstMessage) ||
    navigationCopy.newConversation
  return truncateSessionTitle(title)
}

/**
 * Title for the open conversation tab.
 *
 * Project conversations are not in the no-project session list the shell uses
 * for `session`, so a generated title has to travel with the current session
 * (`sessionName`) or the tab keeps showing the first message.
 */
export function workspaceConversationTitle(input: {
  session: SessionSummary | null
  sessionName?: string | null
  messages: ChatItem[]
  fallback: string
}): string {
  const explicit =
    messageContentTitleText(input.sessionName) || messageContentTitleText(input.session?.name)
  if (explicit) return truncateSessionTitle(explicit)
  if (input.session) return sessionDisplayTitle(input.session)
  return titleFromMessages(input.messages) ?? truncateSessionTitle(input.fallback)
}

function isUserChatMessage(message: ChatItem): message is ChatMessage & { role: 'user' } {
  return message.role === 'user'
}

export function titleFromMessages(messages: ChatItem[]): string | null {
  const title = messages
    .filter(isUserChatMessage)
    .map((message) => messageContentTitleText(message.content))
    .find((content) => content.length > 0)
  return title ? truncateSessionTitle(title) : null
}
