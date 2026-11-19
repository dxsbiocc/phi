import type { ChatQueueJob, ChatQueueJobStatus } from '../../shared/chatQueueTypes'
import { messageContentTitleText } from '../../shared/sessionTitle'
import { redactSensitiveText } from '../agent/redaction'
import { phiOnlySessionPath } from '../agent/session/sessions'
import type { AssistantInboxEntry } from './assistant-inbox'

export interface ChatQueueJobOwner {
  projectId: string | null
  title?: string
  createdAt?: string
}

const QUOTED_SECRET =
  /((?:["']|\b)(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passphrase|authorization)(?:["']|\b)\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/giu

function displayText(text: string): string {
  return redactSensitiveText(text.replace(QUOTED_SECRET, '$1"[redacted]"'))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160)
}

function visibleStatus(status: AssistantInboxEntry['status']): status is ChatQueueJobStatus {
  return (
    status === 'queued' || status === 'running' || status === 'failed' || status === 'interrupted'
  )
}

export function projectChatQueueJobs(
  entries: readonly AssistantInboxEntry[],
  resolveOwner: (sessionId: string) => ChatQueueJobOwner | null
): ChatQueueJob[] {
  const owners = new Map<string, ChatQueueJobOwner | null>()
  const items: ChatQueueJob[] = []
  for (const entry of entries) {
    if (!visibleStatus(entry.status)) continue
    const sessionId = entry.scope.conversationId
    if (!owners.has(sessionId)) owners.set(sessionId, resolveOwner(sessionId))
    const owner = owners.get(sessionId)
    if (!owner || owner.projectId !== entry.scope.projectId) continue
    const title = displayText(messageContentTitleText(owner.title))
    const timestamp = entry.settledAt ?? entry.submittedAt ?? Date.parse(owner.createdAt ?? '')
    const date = new Date(timestamp)
    items.push({
      id: entry.id,
      sessionId,
      sessionPath: phiOnlySessionPath(sessionId),
      ...(title ? { title } : {}),
      preview: displayText(entry.text),
      imageCount: entry.attachments?.length ?? 0,
      status: entry.status,
      timestamp: Number.isFinite(date.valueOf()) ? date.toISOString() : new Date(0).toISOString()
    })
  }
  return items
}
