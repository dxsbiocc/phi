import { mcpOAuthCredentialId as ompMcpOAuthCredentialId } from '@oh-my-pi/pi-coding-agent/mcp/oauth-flow'

export function mcpOAuthCredentialId(serverUrl: string, profile?: string): string {
  return ompMcpOAuthCredentialId(serverUrl, profile)
}
