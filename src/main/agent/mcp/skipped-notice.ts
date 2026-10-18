import type { SessionEventInput, StoredSessionEvent } from '../session/session-store'
import {
  boundedSkippedMcpNotice,
  skippedMcpNoticeFromEvent,
  skippedMcpSignature,
  type SkippedMcpServerNotice
} from '../../../shared/mcpSkippedServers'

export interface SkippedMcpNoticeSink {
  append(sessionId: string, event: SessionEventInput): StoredSessionEvent
  broadcast(sessionId: string, stored: StoredSessionEvent): void
  /** The session's stored timeline; the last announcement is recovered from it after a restart. */
  readEvents(sessionId: string): readonly SessionEventInput[]
}

function lastAnnouncedSignature(events: readonly SessionEventInput[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'mcp_servers_skipped') continue
    return skippedMcpSignature(
      skippedMcpNoticeFromEvent(event as { skippedMcpServers?: unknown }).servers
    )
  }
  return null
}

/**
 * Appends one timeline warning when a conversation's MCP catalog skips servers. The baseline is the
 * last `mcp_servers_skipped` event in the session's own timeline, so it survives restarts. Only a
 * change in (server, user-facing reason category) is announced; an empty set stays quiet and does
 * not reset the baseline.
 */
export function createSkippedMcpNotifier(sink: SkippedMcpNoticeSink): {
  notify(sessionId: string, skipped: readonly SkippedMcpServerNotice[]): void
} {
  const announced = new Map<string, string | null>()
  return {
    notify(sessionId, skipped) {
      if (skipped.length === 0) return
      const { servers, omitted } = boundedSkippedMcpNotice(skipped)
      const signature = skippedMcpSignature(servers)
      if (!announced.has(sessionId))
        announced.set(sessionId, lastAnnouncedSignature(sink.readEvents(sessionId)))
      if (announced.get(sessionId) === signature) return
      announced.set(sessionId, signature)
      const stored = sink.append(sessionId, {
        type: 'mcp_servers_skipped',
        noticeLevel: 'warning',
        skippedMcpServers: servers,
        ...(omitted > 0 ? { skippedMcpOmitted: omitted } : {})
      })
      sink.broadcast(sessionId, stored)
    }
  }
}
