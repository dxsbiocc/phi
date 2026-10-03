import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MCPHttpServerConfig } from '@oh-my-pi/pi-coding-agent/mcp/types'
import {
  clearCredentialSecret,
  readCredentialSecret,
  storeCredentialSecret,
  type SafeStorageLike
} from './credentials/credential-store'
import { getPhiAgentDir } from './runtime-paths'

export const API_KEY_CONNECTOR_IDS = ['tavily', 'serpapi', 'firecrawl', 'browser-use'] as const
export type ApiKeyConnectorId = (typeof API_KEY_CONNECTOR_IDS)[number]

export interface ApiKeyConnectorConfig {
  id: ApiKeyConnectorId
  url: string
  apiKey: { header: string; obtainUrl: string }
}

const API_KEY_CONNECTORS: Record<ApiKeyConnectorId, ApiKeyConnectorConfig> = {
  tavily: {
    id: 'tavily',
    url: 'https://mcp.tavily.com/mcp',
    apiKey: { header: 'Authorization', obtainUrl: 'https://app.tavily.com/home' }
  },
  serpapi: {
    id: 'serpapi',
    url: 'https://mcp.serpapi.com/mcp',
    apiKey: { header: 'Authorization', obtainUrl: 'https://serpapi.com/manage-api-key' }
  },
  firecrawl: {
    id: 'firecrawl',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    apiKey: { header: 'Authorization', obtainUrl: 'https://www.firecrawl.dev/app/api-keys' }
  },
  'browser-use': {
    id: 'browser-use',
    url: 'https://api.browser-use.com/v3/mcp',
    apiKey: {
      header: 'x-browser-use-api-key',
      obtainUrl: 'https://cloud.browser-use.com/settings'
    }
  }
}

export function apiKeyConnector(id: string): ApiKeyConnectorConfig {
  const connector = API_KEY_CONNECTORS[id as ApiKeyConnectorId]
  if (!connector) throw new Error('该连接器不支持 API key')
  return connector
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
  storeCredentialSecret(credentialName(id), key, agentDir, safeStorage)
}

export function clearFeaturedMcpApiKey(id: string, agentDir = getPhiAgentDir()): void {
  clearCredentialSecret(credentialName(id), agentDir)
}

export function readFeaturedMcpApiKey(
  id: string,
  agentDir = getPhiAgentDir(),
  safeStorage?: SafeStorageLike
): string | undefined {
  return readCredentialSecret(credentialName(id), agentDir, safeStorage)
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
    const keys = Object.keys(server).sort().join(',')
    const recognizedShape =
      keys === 'enabled,type,url' ||
      (keys === 'enabled,phiPackage,type,url' && server.phiPackage === id)
    return (
      recognizedShape && server.type === 'http' && server.url === connector.url && !server.enabled
    )
  } catch {
    return false
  }
}
