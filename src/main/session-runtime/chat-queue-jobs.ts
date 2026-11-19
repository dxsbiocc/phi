import type { ChatQueueJob } from '../../shared/chatQueueTypes'
import { messageContentTitleText } from '../../shared/sessionTitle'
import { chatQueuePreview } from './task-preview'
import { phiOnlySessionPath } from '../agent/session/sessions'
import type { AssistantInboxEntry } from './assistant-inbox'

export interface ChatQueueJobOwner {
  projectId: string | null
  title?: string
  createdAt?: string
}

function visibleStatus(entry: AssistantInboxEntry): boolean {
  const { status } = entry
  return (
    entry.independent ||
    status === 'queued' ||
    status === 'running' ||
    status === 'failed' ||
    status === 'interrupted'
  )
}

function jobDetails(entry: AssistantInboxEntry, title: string): Partial<ChatQueueJob> {
  return {
    ...(title ? { title } : {}),
    ...(entry.independent ? { independent: true as const } : {}),
    ...(entry.result ? { result: entry.result } : {})
  }
}

export function projectChatQueueJobs(
  entries: readonly AssistantInboxEntry[],
  resolveOwner: (sessionId: string) => ChatQueueJobOwner | null
): ChatQueueJob[] {
  const owners = new Map<string, ChatQueueJobOwner | null>()
  const items: ChatQueueJob[] = []
  for (const entry of entries) {
    if (!visibleStatus(entry)) continue
    const sessionId = entry.scope.conversationId
    if (!owners.has(sessionId)) owners.set(sessionId, resolveOwner(sessionId))
    const owner = owners.get(sessionId)
    if (!owner || owner.projectId !== entry.scope.projectId) continue
    const title = chatQueuePreview(messageContentTitleText(owner.title))
    const timestamp = entry.settledAt ?? entry.submittedAt ?? Date.parse(owner.createdAt ?? '')
    const date = new Date(timestamp)
    items.push({
      id: entry.id,
      sessionId,
      sessionPath: phiOnlySessionPath(sessionId),
      ...jobDetails(entry, title),
      preview: entry.taskPreview ?? chatQueuePreview(entry.text),
      imageCount: entry.attachments?.length ?? 0,
      status: entry.status,
      timestamp: Number.isFinite(date.valueOf()) ? date.toISOString() : new Date(0).toISOString()
    })
  }
  return items
}
