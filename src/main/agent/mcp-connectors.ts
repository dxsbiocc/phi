import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPhiAgentDir } from './runtime-paths'
import { API_KEY_CONNECTOR_IDS, apiKeyConnector } from './mcp-key-credentials'

const MCP_SERVER_NAME = /^[a-zA-Z0-9_.-]{1,100}$/

type McpConfig = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>
  disabledServers?: string[]
}

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

function disabledServerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === 'string' && MCP_SERVER_NAME.test(item)
  )
}

function managedApiKeyEntry(name: string, value: unknown): boolean {
  try {
    return isPhiManagedApiKeyEntry(value, apiKeyConnector(name).url)
  } catch {
    return false
  }
}

function ownedMcpConfigPath(sourcePath: string, agentDir: string): boolean {
  const normalized = sourcePath.replaceAll('\\', '/')
  if (normalized === configPath(agentDir).replaceAll('\\', '/')) return true
  return (
    normalized.endsWith('/.phi/mcp.json') ||
    normalized.endsWith('/.mcp.json') ||
    normalized.endsWith('/.omp/mcp.json') ||
    normalized.endsWith('/.pi/mcp.json')
  )
}

function setStoredEntryEnabled(config: McpConfig, name: string, enabled: boolean): boolean {
  const entry = config.mcpServers?.[name]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  // API key entries must stay disabled in the file. Pi would otherwise connect
  // them without the key; Phi injects that key in memory while the switch is on.
  if (managedApiKeyEntry(name, entry)) return false
  const record = entry as Record<string, unknown>
  if ((record.enabled !== false) === enabled) return false
  config.mcpServers![name] = { ...record, enabled }
  return true
}

export function readMcpServerEntry(
  name: string,
  agentDir = getPhiAgentDir()
): Record<string, unknown> | undefined {
  const entry = readConfig(configPath(agentDir)).mcpServers?.[name]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  return entry as Record<string, unknown>
}

/** Whether this connector's tools should be offered to the model. */
export function isInjectedMcpServer(name: string, value: unknown, userDisabled: boolean): boolean {
  if (userDisabled) return false
  if (managedApiKeyEntry(name, value)) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return (value as Record<string, unknown>).enabled !== false
}

export function readDisabledMcpServerNames(agentDir = getPhiAgentDir()): string[] {
  return disabledServerNames(readConfig(configPath(agentDir)).disabledServers)
}

export function isMcpConnectorUserDisabled(name: string, agentDir = getPhiAgentDir()): boolean {
  return readDisabledMcpServerNames(agentDir).includes(name)
}

/** User on/off switch. API key entries stay `enabled: false` so Pi does not connect them without the key. */
export function setMcpConnectorEnabled(
  name: string,
  enabled: boolean,
  sourcePath?: string,
  agentDir = getPhiAgentDir()
): void {
  if (!MCP_SERVER_NAME.test(name)) throw new Error('连接器名称无效')
  const userPath = configPath(agentDir)
  const userConfig = readConfig(userPath)
  const disabled = new Set(disabledServerNames(userConfig.disabledServers))
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  if (disabled.size > 0) userConfig.disabledServers = [...disabled].sort()
  else delete userConfig.disabledServers

  const entryPath = sourcePath && ownedMcpConfigPath(sourcePath, agentDir) ? sourcePath : undefined
  const sameFile = !entryPath || entryPath === userPath
  if (sameFile) setStoredEntryEnabled(userConfig, name, enabled)
  writeConfig(userPath, userConfig)

  if (entryPath && !sameFile) {
    const config = readConfig(entryPath)
    if (setStoredEntryEnabled(config, name, enabled)) writeConfig(entryPath, config)
  }
}
