// Caches which featured MCP connector API keys have been verified, and keeps running
// sessions in step when a key changes. Does not store keys; credentials live in mcp-key-credentials.
import { createHash } from 'node:crypto'

import { API_KEY_CONNECTOR_IDS, readFeaturedMcpApiKey } from '../mcp-key-credentials'
import { McpApiKeyValidationError, validateFeaturedMcpApiKey } from '../mcp-key-validation'
import { getPhiEngine } from '../engine/in-process-engine'
import { writeAppLog } from '../app-logger'

const VERIFIED_API_KEY_CACHE_MS = 5 * 60_000

export const verifiedMcpApiKeys = new Map<string, { digest: string; expiresAt: number }>()

export function verificationExpiresAt(id: string): number {
  // SerpApi's account API accepts keys only in a query parameter. Check it at
  // most once per app process for an unchanged key to avoid repeated URL exposure.
  return id === 'serpapi' ? Number.POSITIVE_INFINITY : Date.now() + VERIFIED_API_KEY_CACHE_MS
}

export function apiKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export async function featuredMcpApiKeyVerifiedStatus(id: string): Promise<boolean> {
  const key = readFeaturedMcpApiKey(id)
  if (!key) {
    verifiedMcpApiKeys.delete(id)
    return false
  }
  const digest = apiKeyDigest(key)
  const cached = verifiedMcpApiKeys.get(id)
  if (cached?.digest === digest && cached.expiresAt > Date.now()) return true
  try {
    await validateFeaturedMcpApiKey(id, key)
  } catch (cause) {
    verifiedMcpApiKeys.delete(id)
    if (cause instanceof McpApiKeyValidationError && cause.kind === 'invalid') return false
    throw cause
  }
  verifiedMcpApiKeys.set(id, { digest, expiresAt: verificationExpiresAt(id) })
  return true
}

export async function syncFeaturedMcpApiKeySessions(id: string): Promise<void> {
  if (!API_KEY_CONNECTOR_IDS.some((connectorId) => connectorId === id)) return
  try {
    await getPhiEngine().mcp.syncFeaturedApiKeys({ id })
  } catch {
    // The worker may still hold the previous key. Stop it so a failed sync cannot
    // leave a revoked or rotated credential usable in an existing session.
    writeAppLog({ event: 'mcp_api_key_session_sync_failed', metadata: { connectorId: id } })
    await getPhiEngine().stop()
    throw new Error(
      'Local changes were saved, but the running chat could not be synchronized and was stopped. Reopen the chat and try again.'
    )
  }
}
