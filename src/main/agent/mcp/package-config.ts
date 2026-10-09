import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { EnvironmentNotReadyError } from '../content/environment-refs'
import { getRuntimeRoot } from '../envs'
import type { PhiPlatform } from '../envs/contract'
import type { McpPackageManifest } from '../packages/manifest'
import { getPhiAgentDir } from '../runtime-paths'
import {
  managedStdioServer,
  pendingManagedStdioServer,
  readManagedMarker,
  refreshManagedStdioServers,
  resolveManagedEnvironment,
  type McpConfigLike,
  type RefreshResult
} from './stdio-environment'

export const MCP_PACKAGE_MARKER_FIELD = 'phiPackage'

export type McpConfig = McpConfigLike

export interface McpPackageConfigOptions {
  agentDir?: string
  runtimeRoot?: string
  environmentsDir?: string
  platform?: PhiPlatform
  baseEnv?: NodeJS.ProcessEnv
}

export function mcpConfigPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'mcp.json')
}

export function readMcpConfig(agentDir = getPhiAgentDir()): McpConfig {
  const path = mcpConfigPath(agentDir)
  if (!existsSync(path)) return { mcpServers: {} }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error('MCP 配置文件格式无效')
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error('MCP 配置中的 mcpServers 必须是对象')
  }
  return parsed
}

export function writeMcpConfig(config: McpConfig, agentDir = getPhiAgentDir()): void {
  const path = mcpConfigPath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporaryPath, path)
}

export function packageIdFromMcpEntry(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined
  const value = entry[MCP_PACKAGE_MARKER_FIELD]
  return typeof value === 'string' && /^[a-z][a-z0-9-]{1,63}$/.test(value) ? value : undefined
}

export function installMcpPackageConfig(
  manifest: McpPackageManifest,
  packageDir: string,
  options: McpPackageConfigOptions = {}
): void {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const config = readMcpConfig(agentDir)
  const servers = config.mcpServers ?? {}
  const existing = servers[manifest.id]
  if (existing !== undefined && packageIdFromMcpEntry(existing) !== manifest.id) {
    throw new Error(`已有名为 ${manifest.id} 的用户 MCP 配置；不会覆盖`)
  }
  const existingMarker = readManagedMarker(existing)
  const desiredEnabled = existingMarker?.pending
    ? (existingMarker.desiredEnabled ?? true)
    : isRecord(existing) && typeof existing.enabled === 'boolean'
      ? existing.enabled
      : (existingMarker?.desiredEnabled ??
        (manifest.connector.transport === 'http' && manifest.connector.auth === 'header'
          ? false
          : true))

  let entry: Record<string, unknown>
  if (manifest.connector.transport === 'http') {
    entry = {
      type: 'http',
      url: manifest.connector.url,
      enabled: desiredEnabled,
      [MCP_PACKAGE_MARKER_FIELD]: manifest.id
    }
  } else {
    const managedOptions = {
      root: options.runtimeRoot ?? getRuntimeRoot(agentDir),
      agentDir,
      environmentsDir: options.environmentsDir,
      platform: options.platform,
      ref: manifest.connector.environment,
      command: manifest.connector.command,
      args: manifest.connector.args ?? [],
      cwd: packageDir,
      packageId: manifest.id,
      packageDir,
      desiredEnabled,
      baseEnv: options.baseEnv
    }
    try {
      entry = {
        ...managedStdioServer(managedOptions).entry,
        [MCP_PACKAGE_MARKER_FIELD]: manifest.id
      }
    } catch (error) {
      if (!(error instanceof EnvironmentNotReadyError)) throw error
      entry = {
        ...pendingManagedStdioServer(managedOptions, error).entry,
        [MCP_PACKAGE_MARKER_FIELD]: manifest.id
      }
    }
  }

  writeMcpConfig({ ...config, mcpServers: { ...servers, [manifest.id]: entry } }, agentDir)
}

/** Removes only entries explicitly owned by this package. User entries are retained. */
export function removeMcpPackageConfig(packageId: string, agentDir = getPhiAgentDir()): boolean {
  const config = readMcpConfig(agentDir)
  const servers = config.mcpServers ?? {}
  const next = Object.fromEntries(
    Object.entries(servers).filter(([, entry]) => packageIdFromMcpEntry(entry) !== packageId)
  )
  if (Object.keys(next).length === Object.keys(servers).length) return false
  writeMcpConfig({ ...config, mcpServers: next }, agentDir)
  return true
}

/** Toggles only package-owned entries. Pending entries remember the requested final state. */
export function setMcpPackageConfigEnabled(
  packageId: string,
  enabled: boolean,
  agentDir = getPhiAgentDir()
): boolean {
  const config = readMcpConfig(agentDir)
  const servers = config.mcpServers ?? {}
  let changed = false
  const next = Object.fromEntries(
    Object.entries(servers).map(([name, entry]) => {
      if (packageIdFromMcpEntry(entry) !== packageId || !isRecord(entry)) return [name, entry]
      const marker = readManagedMarker(entry)
      const nextMarker = marker ? { ...marker, desiredEnabled: enabled } : undefined
      if (entry.enabled === enabled && (!marker || marker.desiredEnabled === enabled)) {
        return [name, entry]
      }
      changed = true
      return [
        name,
        {
          ...entry,
          enabled,
          ...(nextMarker ? { phiManaged: nextMarker } : {})
        }
      ]
    })
  )
  if (changed) writeMcpConfig({ ...config, mcpServers: next }, agentDir)
  return changed
}

export interface PersistedManagedRefreshResult extends RefreshResult<McpConfig> {
  written: boolean
}

/** Refreshes managed stdio entries and persists only when at least one entry changed. */
export function refreshPersistedManagedStdioServers(
  options: McpPackageConfigOptions = {}
): PersistedManagedRefreshResult {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const runtimeRoot = options.runtimeRoot ?? getRuntimeRoot(agentDir)
  const config = readMcpConfig(agentDir)
  const result = refreshManagedStdioServers(
    config,
    (request) =>
      resolveManagedEnvironment(request, {
        root: runtimeRoot,
        agentDir,
        environmentsDir: options.environmentsDir,
        platform: options.platform
      }),
    { baseEnv: options.baseEnv }
  )
  const written = result.refreshed.length > 0
  if (written) writeMcpConfig(result.config, agentDir)
  return { ...result, written }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
