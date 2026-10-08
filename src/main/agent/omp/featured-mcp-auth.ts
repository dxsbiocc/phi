import type { AuthStorage } from '@oh-my-pi/pi-ai'
import { connectToServer, disconnectServer, listTools } from '@oh-my-pi/pi-coding-agent/mcp/client'
import { MCPManager } from '@oh-my-pi/pi-coding-agent/mcp/manager'
import {
  discoverOAuthEndpoints,
  type OAuthEndpoints
} from '@oh-my-pi/pi-coding-agent/mcp/oauth-discovery'
import {
  MCPOAuthFlow,
  mcpOAuthCredentialId,
  type MCPStoredOAuthCredential
} from '@oh-my-pi/pi-coding-agent/mcp/oauth-flow'
import {
  API_KEY_CONNECTOR_IDS,
  apiKeyConnector,
  featuredApiKeyMcpConfig
} from '../mcp-key-credentials'
import type { RemoteMcpConnectorOptions } from '../../../shared/mcpConnectorCatalog'

const FEATURED_MCP_AUTH_TIMEOUT_MS = 2 * 60_000

/** Custom services must provide secure endpoints before any client secret is used. */
export async function discoverCustomMcpOAuthEndpoints(
  url: string,
  signal?: AbortSignal
): Promise<OAuthEndpoints> {
  try {
    const endpoints = await discoverOAuthEndpoints(url, undefined, undefined, { signal })
    if (!endpoints) throw new Error('OAuth metadata unavailable')
    for (const value of [endpoints.authorizationUrl, endpoints.tokenUrl]) {
      const endpoint = new URL(value)
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash
      ) {
        throw new Error('OAuth endpoint is not secure')
      }
    }
    if (signal?.aborted) throw new Error('授权已取消')
    return endpoints
  } catch {
    if (signal?.aborted) throw new Error('授权已取消')
    throw new Error('此连接器未提供可用的 HTTPS OAuth 授权信息')
  }
}

export async function authorizeFeaturedMcp(
  url: string,
  authStorage: AuthStorage,
  openAuthUrl: (url: string) => Promise<void>,
  signal?: AbortSignal,
  oauth?: RemoteMcpConnectorOptions['oauth'],
  preparedEndpoints?: OAuthEndpoints,
  beforeStore?: () => void
): Promise<void> {
  const openFailure = new AbortController()
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort('授权已超时'), FEATURED_MCP_AUTH_TIMEOUT_MS)
  const flowSignal = AbortSignal.any([
    timeout.signal,
    openFailure.signal,
    ...(signal ? [signal] : [])
  ])
  try {
    const endpoints =
      preparedEndpoints ??
      (await discoverOAuthEndpoints(url, undefined, undefined, { signal: flowSignal }))
    if (!endpoints) throw new Error('此 MCP 服务未提供可用的 OAuth 授权信息')
    const flow = new MCPOAuthFlow(
      {
        ...endpoints,
        ...(oauth?.clientId ? { clientId: oauth.clientId, clientSecret: oauth.clientSecret } : {}),
        resource: endpoints.resource ?? url,
        stripSameOriginResource: !endpoints.resource
      },
      {
        signal: flowSignal,
        onAuth: ({ url: authorizationUrl }) => {
          void openAuthUrl(authorizationUrl).catch((error: unknown) => openFailure.abort(error))
        }
      }
    )
    const credentials = await flow.login()
    flowSignal.throwIfAborted()
    beforeStore?.()
    const stored: MCPStoredOAuthCredential = {
      type: 'oauth',
      ...credentials,
      tokenUrl: endpoints.tokenUrl,
      clientId: flow.resolvedClientId,
      clientSecret: oauth?.clientSecret ?? flow.registeredClientSecret,
      resource: flow.resource,
      authorizationUrl: flow.authorizationUrl
    }
    await authStorage.set(mcpOAuthCredentialId(url), stored)
  } catch (error) {
    if (timeout.signal.aborted) throw new Error('授权已超时')
    if (signal?.aborted) throw new Error('授权已取消')
    const message = error instanceof Error ? error.message : ''
    const openReason = openFailure.signal.reason
    if (
      message === '连接器配置已变化，请重新授权' ||
      (openReason instanceof Error && openReason.message === '连接器配置已变化，请重新授权')
    ) {
      throw new Error('连接器配置已变化，请重新授权')
    }
    if (message === '此 MCP 服务未提供可用的 OAuth 授权信息') {
      throw new Error('此 MCP 服务未提供可用的 OAuth 授权信息')
    }
    // OAuth providers can echo submitted secrets in response bodies, including encoded forms.
    // Construct a fresh safe error so the original message, stack, and cause never cross IPC.
    throw new Error('连接器授权失败，请检查客户端信息并重试')
  } finally {
    clearTimeout(timer)
  }
}

export async function listFeaturedMcpTools(
  name: string,
  url: string,
  authStorage?: AuthStorage,
  apiKey?: string
): Promise<string[]> {
  if (API_KEY_CONNECTOR_IDS.some((id) => id === name)) {
    if (!apiKey || apiKeyConnector(name).url !== url) {
      throw new Error('该连接器需要已保存的 API key 和官方地址')
    }
  }
  const manager = new MCPManager(process.cwd())
  if (authStorage) manager.setAuthStorage(authStorage)
  const config = await manager.prepareConfig(
    apiKey ? featuredApiKeyMcpConfig(name, apiKey) : { type: 'http', url, timeout: 10_000 }
  )
  const signal = AbortSignal.timeout(12_000)
  const connection = await connectToServer(name, config, { signal })
  try {
    return (await listTools(connection, { signal })).map((tool) => tool.name)
  } finally {
    await disconnectServer(connection).catch(() => undefined)
  }
}
