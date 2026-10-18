/** Stable codes for why one MCP server was left out of a conversation. Display text is localized elsewhere. */
export const MCP_SKIP_REASONS = [
  'unavailable',
  'stdio_not_allowed',
  'env_not_ready',
  'profile_changed',
  'api_key_missing',
  'api_key_unavailable',
  'prepare_failed',
  'connect_failed',
  'startup_failed',
  'startup_pending',
  'not_connected',
  'backoff'
] as const
export type McpSkipReasonCode = (typeof MCP_SKIP_REASONS)[number]

export interface SkippedMcpServerNotice {
  readonly name: string
  readonly reason: McpSkipReasonCode
}

/** What the user sees: reasons that render identically share one category. */
export type McpSkipReasonCategory =
  | 'unavailable'
  | 'stdio_not_allowed'
  | 'env_not_ready'
  | 'profile_changed'
  | 'missing_key'
  | 'not_connected'

export function mcpSkipReasonCategory(reason: McpSkipReasonCode): McpSkipReasonCategory {
  switch (reason) {
    case 'unavailable':
    case 'stdio_not_allowed':
    case 'env_not_ready':
    case 'profile_changed':
      return reason
    case 'api_key_missing':
    case 'api_key_unavailable':
      return 'missing_key'
    default:
      return 'not_connected'
  }
}

/** Order-independent identity of a skipped set as the user perceives it (name + reason category). */
export function skippedMcpSignature(skipped: readonly SkippedMcpServerNotice[]): string {
  return JSON.stringify(
    skipped.map((server) => [server.name, mcpSkipReasonCategory(server.reason)]).sort()
  )
}

/** Upper bound on skipped servers accepted across the worker boundary (matches the server-name limit). */
export const MAX_SKIPPED_MCP_SERVERS_WIRE = 256
/** Bounds for what is stored in, and shown from, a timeline notice. */
export const MAX_SKIPPED_MCP_NOTICE_SERVERS = 20
export const MAX_SKIPPED_MCP_NOTICE_NAME = 64

export function isMcpSkipReason(value: unknown): value is McpSkipReasonCode {
  return typeof value === 'string' && (MCP_SKIP_REASONS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strict shape check; undefined when anything is off so callers can reject the whole payload. */
export function skippedMcpServersValue(value: unknown): SkippedMcpServerNotice[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_SKIPPED_MCP_SERVERS_WIRE) return undefined
  const seen = new Set<string>()
  const result: SkippedMcpServerNotice[] = []
  for (const item of value) {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== 2 ||
      typeof item.name !== 'string' ||
      !item.name ||
      item.name.length > 512 ||
      !isMcpSkipReason(item.reason) ||
      seen.has(item.name)
    )
      return undefined
    seen.add(item.name)
    result.push({ name: item.name, reason: item.reason })
  }
  return result
}

/** Notice payload: first N servers with capped names, plus how many were left out of the list. */
export function boundedSkippedMcpNotice(skipped: readonly SkippedMcpServerNotice[]): {
  servers: SkippedMcpServerNotice[]
  omitted: number
} {
  const servers = skipped.slice(0, MAX_SKIPPED_MCP_NOTICE_SERVERS).map((server) => ({
    name: server.name.slice(0, MAX_SKIPPED_MCP_NOTICE_NAME),
    reason: server.reason
  }))
  return { servers, omitted: skipped.length - servers.length }
}

/** Renderer-side read of a stored notice; ignores malformed entries instead of throwing. */
export function skippedMcpNoticeFromEvent(event: {
  skippedMcpServers?: unknown
  skippedMcpOmitted?: unknown
}): { servers: SkippedMcpServerNotice[]; omitted: number } {
  const servers: SkippedMcpServerNotice[] = []
  if (Array.isArray(event.skippedMcpServers))
    for (const item of event.skippedMcpServers.slice(0, MAX_SKIPPED_MCP_NOTICE_SERVERS))
      if (
        isRecord(item) &&
        typeof item.name === 'string' &&
        item.name &&
        isMcpSkipReason(item.reason)
      )
        servers.push({ name: item.name.slice(0, MAX_SKIPPED_MCP_NOTICE_NAME), reason: item.reason })
  const omitted =
    typeof event.skippedMcpOmitted === 'number' &&
    Number.isInteger(event.skippedMcpOmitted) &&
    event.skippedMcpOmitted > 0
      ? event.skippedMcpOmitted
      : 0
  return { servers, omitted }
}
