import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import { errorMessage } from '../../../../../shared/errorCodes'
import type { McpServerSummary } from '../../../types'
import type { ConnectorAuthStatus } from '../components/McpFeaturedConnectorCard'
import { connectorCopy } from './connectorCopy'
import { featuredOAuthStatusFromError } from './featuredAuthStatus'
import { cacheFeaturedToolNames, cachedFeaturedToolNames } from './featuredToolCache'

export function ipcErrorMessage(cause: unknown): string {
  const message = errorMessage(cause)
  return message.replace(/^Error invoking remote method '[^']+': (?:[^:]+: )?/, '')
}

export function apiKeyErrorMessage(cause: unknown): string {
  const message = errorMessage(cause)
  return message.replace(
    /^Error invoking remote method ['"]mcp:setFeaturedApiKey['"]: (?:McpApiKeyValidationError|Error): /,
    ''
  )
}

export function matchingServer(
  connector: FeaturedMcpConnector,
  servers: readonly McpServerSummary[]
): McpServerSummary | undefined {
  return servers.find(
    (server) =>
      server.packageId === connector.id ||
      server.connectorId === connector.id ||
      (connector.url !== undefined &&
        server.url === connector.url &&
        (!connector.apiKey || server.name === connector.id))
  )
}

export function probeFeaturedConnectorAuthStatuses(
  entries: readonly FeaturedMcpConnector[],
  isActive: () => boolean,
  onStatus: (id: string, status: ConnectorAuthStatus) => void
): void {
  for (const connector of entries.filter(
    (entry) => entry.oauthAuthorizationOrigin || entry.apiKey
  )) {
    const cachedTools = cachedFeaturedToolNames(connector.id)
    const status = connector.apiKey
      ? typeof window.api.getFeaturedMcpApiKeyStatus === 'function'
        ? window.api.getFeaturedMcpApiKeyStatus(connector.id)
        : Promise.reject(new Error(connectorCopy.keyApiMissing))
      : typeof window.api.getFeaturedMcpAuthStatus === 'function'
        ? window.api.getFeaturedMcpAuthStatus(connector.id)
        : cachedTools !== null
          ? Promise.resolve(true)
          : window.api.listFeaturedMcpTools(connector.id).then((names) => {
              cacheFeaturedToolNames(connector.id, names)
              return true
            })
    void status
      .then((authenticated) => {
        if (isActive()) onStatus(connector.id, authenticated ? 'authenticated' : 'unauthenticated')
      })
      .catch((cause: unknown) => {
        if (!isActive()) return
        const message = ipcErrorMessage(cause)
        onStatus(
          connector.id,
          connector.oauthAuthorizationOrigin
            ? featuredOAuthStatusFromError(message, connector.name)
            : 'unavailable'
        )
      })
  }
}
