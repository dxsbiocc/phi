import type { MCPHttpServerConfig as OmpMCPHttpServerConfig } from '@oh-my-pi/pi-coding-agent/mcp/types'

/** Phi-owned HTTP MCP configuration exposed outside the engine boundary. */
export interface MCPAuthConfig {
  type: 'oauth' | 'apikey'
  credentialId?: string
  tokenUrl?: string
  clientId?: string
  clientSecret?: string
  resource?: string
}

export interface MCPOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
  redirectUri?: string
  callbackPort?: number
  callbackPath?: string
  prompt?: string
}

export interface MCPHttpServerConfig {
  type: 'http'
  url: string
  enabled?: boolean
  timeout?: number
  requestIdFormat?: 'string' | 'number'
  auth?: MCPAuthConfig
  oauth?: MCPOAuthConfig
  headers?: Record<string, string>
  headerPolicy?: 'origin-locked'
}

type IsAssignable<From, To> = [From] extends [To] ? true : false
type Assert<T extends true> = T

const mcpHttpServerConfigCompatibility: [
  Assert<IsAssignable<MCPHttpServerConfig, OmpMCPHttpServerConfig>>,
  Assert<IsAssignable<OmpMCPHttpServerConfig, MCPHttpServerConfig>>
] = [true, true]
void mcpHttpServerConfigCompatibility
