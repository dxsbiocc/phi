import { agentRunNotice, type AgentRunFinishedEvent } from '../../../../../shared/agentRunNotice'
import {
  wrapperRunNotice,
  type WrapperRunFinishedEvent
} from '../../../../../shared/wrapperRunNotice'
import type { ChatItem } from '../../../types'
import { getUiLanguage } from '../../../lib/i18n'
import { approvalItemFromEvent } from './approvalTimeline'
import { chatCopy } from './chatCopy'
import { chatEventCopy } from './chatEventCopy'
import { skippedMcpNoticeFromEvent } from '../../../../../shared/mcpSkippedServers'

function createdAtField(createdAt?: string): { createdAt: string } | Record<string, never> {
  return typeof createdAt === 'string' ? { createdAt } : {}
}
function runIdField(runId?: unknown): { runId: string } | Record<string, never> {
  return typeof runId === 'string' && runId ? { runId } : {}
}

export function chatItemFromPhiTimelineEvent(event: {
  type?: string
  eventId?: string
  runId?: string
  approvalId?: string
  phiSessionId?: string
  sessionId?: string
  toolCallId?: string
  toolName?: unknown
  summary?: unknown
  shortSummary?: unknown
  reason?: unknown
  action?: unknown
  tokensBefore?: unknown
  tokensAfter?: unknown
  noticeText?: unknown
  noticeLevel?: unknown
  skippedMcpServers?: unknown
  skippedMcpOmitted?: unknown
  errorMessage?: unknown
  createdAt?: string
  fromProviderId?: unknown
  fromModelId?: unknown
  toProviderId?: unknown
  toModelId?: unknown
  toModelName?: unknown
}): ChatItem | null {
  const approval = approvalItemFromEvent(event)
  if (approval) return approval
  const id = event.eventId ?? `${event.type ?? 'phi'}-${event.runId ?? event.approvalId ?? 'event'}`
  if (event.type === 'run_interrupted') {
    return {
      id,
      role: 'warning',
      get content() {
        return event.reason === 'app_restarted'
          ? chatEventCopy.interruptedByRestart
          : chatEventCopy.interrupted
      },
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'run_failed') {
    const error = typeof event.errorMessage === 'string' ? event.errorMessage.trim() : ''
    return {
      id,
      role: 'error',
      get content() {
        return error || chatEventCopy.runFailed
      },
      ...runIdField(event.runId),
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'context_compacted') {
    return {
      id,
      role: 'warning',
      get content() {
        return chatEventCopy.contextCompacted
      },
      contextCompaction: {
        action: typeof event.action === 'string' ? event.action : 'unknown',
        ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
        ...(typeof event.tokensBefore === 'number' &&
        Number.isFinite(event.tokensBefore) &&
        event.tokensBefore >= 0
          ? { tokensBefore: event.tokensBefore }
          : {}),
        ...(typeof event.tokensAfter === 'number' &&
        Number.isFinite(event.tokensAfter) &&
        event.tokensAfter >= 0
          ? { tokensAfter: event.tokensAfter }
          : {}),
        ...(typeof event.summary === 'string' ? { summary: event.summary } : {}),
        ...(typeof event.shortSummary === 'string' ? { shortSummary: event.shortSummary } : {})
      },
      ...runIdField(event.runId),
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'context_shaken') {
    return {
      id,
      role: 'warning',
      get content() {
        return chatCopy.contextCompacted
      },
      contextCompaction: { action: 'shake' },
      ...runIdField(event.runId),
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'remote_run_stopped') {
    return {
      id,
      role: 'warning',
      get content() {
        return chatEventCopy.remoteRunStopped
      },
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'mcp_servers_skipped') {
    const { servers, omitted } = skippedMcpNoticeFromEvent(event)
    if (servers.length === 0) return null
    return {
      id,
      role: 'warning',
      get content() {
        const sep = chatEventCopy.listSeparator
        const local = servers.filter((server) => server.reason === 'stdio_not_allowed')
        const others = servers.filter((server) => server.reason !== 'stdio_not_allowed')
        return [
          local.length
            ? chatEventCopy.mcpLocalSkipped(local.map((server) => server.name).join(sep))
            : '',
          others.length
            ? chatEventCopy.mcpOthersSkipped(
                others
                  .map((server) =>
                    chatEventCopy.mcpOther(
                      server.name,
                      chatEventCopy.mcpReason[server.reason] ??
                        chatEventCopy.mcpReason.not_connected
                    )
                  )
                  .join(sep)
              )
            : '',
          omitted > 0 ? chatEventCopy.mcpMore(omitted) : ''
        ]
          .filter(Boolean)
          .join(' ')
      },
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'context_maintenance_notice') {
    // Successful maintenance has its own compacted status; its process diagnostics stay in storage.
    if (event.noticeLevel !== 'warning' && event.noticeLevel !== 'error') return null
    const raw = typeof event.noticeText === 'string' ? event.noticeText : ''
    const images = raw.match(/dropped (\d+) attached images?/i)

    return {
      id,
      role: event.noticeLevel === 'error' ? 'error' : 'warning',
      get content() {
        return images
          ? chatEventCopy.imagesRemoved(images[1])
          : chatEventCopy.maintenanceNotice(raw || chatCopy.noFurtherDetails)
      },
      ...runIdField(event.runId),
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'context_compaction_failed') {
    const error = typeof event.errorMessage === 'string' ? event.errorMessage : ''
    return {
      id,
      role: 'error',
      get content() {
        return chatEventCopy.compactionFailure(error)
      },
      contextCompaction: {
        action: typeof event.action === 'string' ? event.action : 'unknown',
        ...(typeof event.reason === 'string' ? { reason: event.reason } : {})
      },
      ...runIdField(event.runId),
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'model_selection_migrated' || event.type === 'model_fallback') {
    const from =
      typeof event.fromProviderId === 'string' && typeof event.fromModelId === 'string'
        ? `${event.fromProviderId}/${event.fromModelId}`
        : null
    const to =
      typeof event.toProviderId === 'string' && typeof event.toModelId === 'string'
        ? `${event.toProviderId}/${event.toModelId}`
        : typeof event.toModelName === 'string'
          ? event.toModelName
          : null
    return {
      id,
      role: 'warning',
      get content() {
        const previous = from ?? chatEventCopy.previousModel
        const available = to ?? chatEventCopy.availableModel
        return event.type === 'model_fallback'
          ? chatEventCopy.modelFallback(previous, available)
          : chatEventCopy.modelMigrated(previous, available)
      },
      ...runIdField(event.runId),
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'wrapper_run_finished') {
    const finished = event as unknown as WrapperRunFinishedEvent
    return {
      id,
      role: 'warning',
      get content() {
        const notice = wrapperRunNotice(finished, getUiLanguage())
        return `${notice.title}\n${notice.body}`
      },
      backgroundJobNotice: { state: finished.state },
      ...createdAtField(event.createdAt)
    }
  }
  if (event.type === 'agent_run_finished') {
    const finished = event as unknown as AgentRunFinishedEvent
    const stateMap = { done: 'completed', error: 'failed', cancelled: 'cancelled' } as const
    return {
      id,
      role: 'warning',
      get content() {
        const notice = agentRunNotice(finished, getUiLanguage())
        return `${notice.title}\n${notice.body}`
      },
      backgroundJobNotice: { state: stateMap[finished.state] },
      ...createdAtField(event.createdAt)
    }
  }
  return null
}
