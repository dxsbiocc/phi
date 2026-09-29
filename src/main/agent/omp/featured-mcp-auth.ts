import type { AuthStorage } from '@oh-my-pi/pi-ai'
import { connectToServer, disconnectServer, listTools } from '@oh-my-pi/pi-coding-agent/mcp/client'
import { MCPManager } from '@oh-my-pi/pi-coding-agent/mcp/manager'
import { discoverOAuthEndpoints } from '@oh-my-pi/pi-coding-agent/mcp/oauth-discovery'
import {
  MCPOAuthFlow,
  mcpOAuthCredentialId,
  type MCPStoredOAuthCredential
} from '@oh-my-pi/pi-coding-agent/mcp/oauth-flow'

export async function authorizeFeaturedMcp(
  url: string,
  authStorage: AuthStorage,
  openAuthUrl: (url: string) => Promise<void>
): Promise<void> {
  const endpoints = await discoverOAuthEndpoints(url)
  if (!endpoints) throw new Error('此 MCP 服务未提供可用的 OAuth 授权信息')

  const openFailure = new AbortController()
  const flow = new MCPOAuthFlow(
    {
      ...endpoints,
      resource: endpoints.resource ?? url,
      stripSameOriginResource: !endpoints.resource
    },
    {
      signal: AbortSignal.any([AbortSignal.timeout(5 * 60_000), openFailure.signal]),
      onAuth: ({ url: authorizationUrl }) => {
        void openAuthUrl(authorizationUrl).catch((error: unknown) => openFailure.abort(error))
      }
    }
  )
  const credentials = await flow.login()
  const stored: MCPStoredOAuthCredential = {
    type: 'oauth',
    ...credentials,
    tokenUrl: endpoints.tokenUrl,
    clientId: flow.resolvedClientId,
    clientSecret: flow.registeredClientSecret,
    resource: flow.resource,
    authorizationUrl: flow.authorizationUrl
  }
  await authStorage.set(mcpOAuthCredentialId(url), stored)
}

export async function listFeaturedMcpTools(
  name: string,
  url: string,
  authStorage?: AuthStorage
): Promise<string[]> {
  const manager = new MCPManager(process.cwd())
  if (authStorage) manager.setAuthStorage(authStorage)
  const config = await manager.prepareConfig({ type: 'http', url, timeout: 10_000 })
  const signal = AbortSignal.timeout(12_000)
  const connection = await connectToServer(name, config, { signal })
  try {
    return (await listTools(connection, { signal })).map((tool) => tool.name)
  } finally {
    await disconnectServer(connection).catch(() => undefined)
  }
}
