import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MCPHttpServerConfig } from '@oh-my-pi/pi-coding-agent/mcp/types'
import { featuredMcpConnectors, type FeaturedMcpConnector } from '../../shared/mcpConnectorCatalog'
import {
  clearDbConnectorSecret,
  readDbConnectorSecret,
  storeDbConnectorSecret,
  type SafeStorageLike
} from './db/credential-store'
import { getPhiAgentDir } from './runtime-paths'

export const API_KEY_CONNECTOR_IDS = ['tavily', 'serpapi', 'firecrawl', 'browser-use'] as const
const apiKeyConnectorIds = new Set<string>(API_KEY_CONNECTOR_IDS)

export function apiKeyConnector(id: string): FeaturedMcpConnector & {
  apiKey: NonNullable<FeaturedMcpConnector['apiKey']>
} {
  const connector = featuredMcpConnectors.find((entry) => entry.id === id)
  if (!apiKeyConnectorIds.has(id) || !connector?.apiKey) {
    throw new Error('该连接器不支持 API key')
  }
  return connector as FeaturedMcpConnector & {
    apiKey: NonNullable<FeaturedMcpConnector['apiKey']>
  }
}

function credentialName(id: string): string {
  apiKeyConnector(id)
  return `PHI_MCP_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

export function setFeaturedMcpApiKey(
  id: string,
  key: string,
  agentDir = getPhiAgentDir(),
  safeStorage?: SafeStorageLike
): void {
  if (typeof key !== 'string' || /[\r\n\0]/.test(key)) throw new Error('API key 格式无效')
  storeDbConnectorSecret(credentialName(id), key, agentDir, safeStorage)
}

export function clearFeaturedMcpApiKey(id: string, agentDir = getPhiAgentDir()): void {
  clearDbConnectorSecret(credentialName(id), agentDir)
}

export function readFeaturedMcpApiKey(
  id: string,
  agentDir = getPhiAgentDir(),
  safeStorage?: SafeStorageLike
): string | undefined {
  return readDbConnectorSecret(credentialName(id), agentDir, safeStorage)
}

export function featuredMcpApiKeyStatus(
  id: string,
  agentDir = getPhiAgentDir(),
  safeStorage?: SafeStorageLike
): boolean {
  return Boolean(readFeaturedMcpApiKey(id, agentDir, safeStorage))
}

export function featuredApiKeyMcpConfig(id: string, key: string): MCPHttpServerConfig {
  const connector = apiKeyConnector(id)
  if (!key || /[\r\n\0]/.test(key)) throw new Error('API key 格式无效')
  return {
    type: 'http',
    url: connector.url,
    headers: {
      [connector.apiKey.header]: connector.apiKey.header === 'Authorization' ? `Bearer ${key}` : key
    },
    headerPolicy: 'origin-locked',
    timeout: 10_000
  }
}

/** Only Phi-managed, disabled entries are eligible for in-memory authenticated connection. */
export function isFeaturedMcpApiKeyInstalled(id: string, agentDir = getPhiAgentDir()): boolean {
  const connector = apiKeyConnector(id)
  const path = join(agentDir, 'mcp.json')
  if (!existsSync(path)) return false
  try {
    const config: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false
    const servers = (config as { mcpServers?: unknown }).mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false
    const entry = (servers as Record<string, unknown>)[id]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const server = entry as Record<string, unknown>
    return (
      Object.keys(server).sort().join(',') === 'enabled,type,url' &&
      server.type === 'http' &&
      server.url === connector.url &&
      server.enabled === false
    )
  } catch {
    return false
  }
}
