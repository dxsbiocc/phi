import type { SessionEventInput, StoredSessionEvent } from '../session/session-store'
import {
  boundedSkippedMcpNotice,
  type SkippedMcpServerNotice
} from '../../../shared/mcpSkippedServers'

export interface SkippedMcpNoticeSink {
  append(sessionId: string, event: SessionEventInput): StoredSessionEvent
  broadcast(sessionId: string, stored: StoredSessionEvent): void
}

/**
 * Appends one timeline warning when a conversation's MCP catalog skips servers. The same skipped
 * set is never announced twice for a session; a changed set (or one that cleared and came back)
 * is announced again.
 */
export function createSkippedMcpNotifier(sink: SkippedMcpNoticeSink): {
  notify(sessionId: string, skipped: readonly SkippedMcpServerNotice[]): void
} {
  const announced = new Map<string, string>()
  return {
    notify(sessionId, skipped) {
      if (skipped.length === 0) {
        announced.delete(sessionId)
        return
      }
      const signature = JSON.stringify(skipped.map((server) => [server.name, server.reason]).sort())
      if (announced.get(sessionId) === signature) return
      announced.set(sessionId, signature)
      const { servers, omitted } = boundedSkippedMcpNotice(skipped)
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
