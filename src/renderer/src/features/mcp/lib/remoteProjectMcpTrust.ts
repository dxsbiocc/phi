import type {
  RemoteProjectMcpServerSummary,
  RemoteProjectMcpTrustRequest
} from '../../../../../shared/remoteProjectMcpTypes'
import type { McpServerSummary } from './mcpTypes'

import { isRecord } from '../../../../../shared/guards'
export type TrustedRemoteProjectMcpServer = McpServerSummary & RemoteProjectMcpServerSummary

export function isRemoteProjectMcpServer(
  value: McpServerSummary
): value is TrustedRemoteProjectMcpServer {
  const candidate = value as unknown as Record<string, unknown>
  return (
    typeof candidate.sourcePath === 'string' &&
    candidate.sourcePath.startsWith('ssh://') &&
    typeof candidate.remoteProjectCwd === 'string' &&
    typeof candidate.relativePath === 'string' &&
    typeof candidate.contentHash === 'string' &&
    (candidate.trustState === 'pending' ||
      candidate.trustState === 'trusted' ||
      candidate.trustState === 'changed' ||
      candidate.trustState === 'invalid') &&
    typeof candidate.available === 'boolean' &&
    Array.isArray(candidate.confirmationItems) &&
    candidate.confirmationItems.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.serverName === 'string' &&
        typeof item.kind === 'string' &&
        typeof item.value === 'string'
    )
  )
}

export function remoteProjectMcpTrustRequest(
  server: TrustedRemoteProjectMcpServer,
  confirmedItemIds: readonly string[]
): RemoteProjectMcpTrustRequest {
  return {
    cwd: server.remoteProjectCwd,
    relativePath: server.relativePath,
    contentHash: server.contentHash,
    confirmedItemIds: [...confirmedItemIds]
  }
}
