import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPhiAgentDir } from './runtime-paths'
import { API_KEY_CONNECTOR_IDS, apiKeyConnector } from './mcp-key-credentials'

type McpConfig = Record<string, unknown> & { mcpServers?: Record<string, unknown> }

function configPath(agentDir: string): string {
  return join(agentDir, 'mcp.json')
}

function readConfig(path: string): McpConfig {
  if (!existsSync(path)) return { mcpServers: {} }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP 配置文件格式无效')
  }
  const config = parsed as McpConfig
  if (
    config.mcpServers !== undefined &&
    (!config.mcpServers ||
      typeof config.mcpServers !== 'object' ||
      Array.isArray(config.mcpServers))
  ) {
    throw new Error('MCP 配置中的 mcpServers 必须是对象')
  }
  return config
}

function writeConfig(path: string, config: McpConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporaryPath, path)
}

function validateName(name: string): string {
  const trimmed = name.trim()
  if (!/^[a-z][a-z0-9_-]{1,63}$/i.test(trimmed)) {
    throw new Error('连接器名称需为 2–64 位字母、数字、下划线或连字符，并以字母开头')
  }
  return trimmed
}

function validateUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请输入有效的 HTTPS MCP 地址')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('MCP 地址必须是无凭据、无片段的 HTTPS URL')
  }
  return url.toString()
}

function isPhiManagedApiKeyEntry(
  value: unknown,
  url: string
): value is {
  type: 'http'
  url: string
  enabled: boolean
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    Object.keys(entry).sort().join(',') === 'enabled,type,url' &&
    entry.type === 'http' &&
    entry.url === url &&
    typeof entry.enabled === 'boolean'
  )
}

export function addRemoteMcpConnector(
  name: string,
  url: string,
  agentDir = getPhiAgentDir()
): void {
  const validatedName = validateName(name)
  const validatedUrl = validateUrl(url)
  const apiKeyConnectorEntry = (() => {
    try {
      return apiKeyConnector(validatedName)
    } catch {
      return undefined
    }
  })()
  if (apiKeyConnectorEntry && validatedUrl !== apiKeyConnectorEntry.url) {
    throw new Error('API key 连接器地址与官方地址不匹配')
  }
  const path = configPath(agentDir)
  const config = readConfig(path)
  const servers = config.mcpServers ?? {}
  const existing = servers[validatedName]
  if (existing !== undefined) {
    if (
      existing &&
      typeof existing === 'object' &&
      (existing as Record<string, unknown>).url === validatedUrl
    ) {
      if (apiKeyConnectorEntry) {
        if (!isPhiManagedApiKeyEntry(existing, validatedUrl)) {
          throw new Error(`已有名为 ${validatedName} 的自定义 MCP 配置，请先移除或重命名`)
        }
        if (existing.enabled) {
          writeConfig(path, {
            ...config,
            mcpServers: {
              ...servers,
              [validatedName]: { type: 'http', url: validatedUrl, enabled: false }
            }
          })
        }
      }
      return
    }
    throw new Error(`已有名为 ${validatedName} 的 MCP 配置`)
  }
  writeConfig(path, {
    ...config,
    mcpServers: {
      ...servers,
      [validatedName]: { type: 'http', url: validatedUrl, enabled: !apiKeyConnectorEntry }
    }
  })
}

/** Upgrade older managed entries before Pi scans mcp.json. */
export function disableFeaturedApiKeyAutoDiscovery(agentDir = getPhiAgentDir()): void {
  const path = configPath(agentDir)
  const config = readConfig(path)
  const servers = config.mcpServers ?? {}
  let changed = false
  const updated = { ...servers }
  for (const id of API_KEY_CONNECTOR_IDS) {
    const entry = servers[id]
    const connector = apiKeyConnector(id)
    if (isPhiManagedApiKeyEntry(entry, connector.url) && entry.enabled) {
      updated[id] = { type: 'http', url: connector.url, enabled: false }
      changed = true
    }
  }
  if (changed) writeConfig(path, { ...config, mcpServers: updated })
}

export function removeRemoteMcpConnector(
  name: string,
  url: string,
  agentDir = getPhiAgentDir()
): void {
  const validatedName = validateName(name)
  const validatedUrl = validateUrl(url)
  const path = configPath(agentDir)
  const config = readConfig(path)
  const servers = config.mcpServers ?? {}
  const existing = servers[validatedName]
  if (
    !existing ||
    typeof existing !== 'object' ||
    (existing as Record<string, unknown>).url !== validatedUrl
  ) {
    throw new Error('连接器配置已变化，请刷新后重试')
  }
  const remaining = { ...servers }
  delete remaining[validatedName]
  writeConfig(path, { ...config, mcpServers: remaining })
}
