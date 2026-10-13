import { loadAllMCPConfigs as loadOmpMCPConfigs } from '@oh-my-pi/pi-coding-agent/mcp/config'
import { MCPManager as OmpMCPManager } from '@oh-my-pi/pi-coding-agent/mcp/manager'
import type { MCPServerConfig as OmpMCPServerConfig } from '@oh-my-pi/pi-coding-agent/mcp/types'

import type { MCPAuthConfig, MCPHttpServerConfig, MCPOAuthConfig } from './types'

export interface MCPExtensionRoots {
  explicit: readonly string[]
  mode: 'merge' | 'explicit-only'
  configured: readonly string[]
  configuredLevel: 'user' | 'project'
}

export interface LoadMCPConfigsOptions {
  enableProjectConfig?: boolean
  filterExa?: boolean
  filterBrowser?: boolean
  extensionRoots?: MCPExtensionRoots
}

export interface MCPSource {
  provider: string
  providerName: string
  path: string
  level: 'user' | 'project' | 'native'
  origin?: string
}

export interface MCPStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  envPolicy?: 'literal'
  envLiteralKeys?: string[]
  cwd?: string
  enabled?: boolean
  timeout?: number
  requestIdFormat?: 'string' | 'number'
  auth?: MCPAuthConfig
  oauth?: MCPOAuthConfig
}

export interface MCPSseServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
  headerPolicy?: 'origin-locked'
  enabled?: boolean
  timeout?: number
  requestIdFormat?: 'string' | 'number'
  auth?: MCPAuthConfig
  oauth?: MCPOAuthConfig
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig

export interface LoadMCPConfigsResult {
  configs: Record<string, MCPServerConfig>
  exaApiKeys: string[]
  sources: Record<string, MCPSource>
}

export async function loadAllMCPConfigs(
  cwd: string,
  options?: LoadMCPConfigsOptions
): Promise<LoadMCPConfigsResult> {
  return loadOmpMCPConfigs(cwd, options)
}

type MCPConfigLoader = (
  cwd: string,
  options?: LoadMCPConfigsOptions
) => Promise<LoadMCPConfigsResult>

/** Runtime-compatible MCP manager kept behind Phi's MCP boundary module. */
export class MCPManager extends OmpMCPManager {
  constructor(cwd: string, toolCache: null = null, loadConfigs?: MCPConfigLoader) {
    super(cwd, toolCache, loadConfigs)
  }
}

const phiMcpServerConfigAcceptedByOmp: OmpMCPServerConfig = {} as MCPServerConfig
const ompMcpServerConfigAcceptedByPhi: MCPServerConfig = {} as OmpMCPServerConfig
void phiMcpServerConfigAcceptedByOmp
void ompMcpServerConfigAcceptedByPhi
