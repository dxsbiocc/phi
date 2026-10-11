import type { FeaturedMcpConnector } from '../../shared/mcpConnectorCatalog'
import { resolveCuratedResourceIcon } from './curated-icons'
import type { McpServerSummary } from './resources'

/**
 * Describe each configured server with the catalog connector it came from. The icon is the
 * server's own, else the catalog's logo, and only then a generated one, so a real logo is never
 * replaced.
 */
export function withConnectorMetadata(
  servers: readonly McpServerSummary[],
  catalog: readonly FeaturedMcpConnector[]
): McpServerSummary[] {
  return servers.map((server) => {
    const connector = catalog.find(
      (entry) =>
        entry.id === server.packageId || (server.url !== undefined && entry.url === server.url)
    )
    const icon =
      server.icon ??
      connector?.icon ??
      resolveCuratedResourceIcon('mcp', server.packageId ?? server.id)
    const withIcon = icon ? { ...server, icon } : server
    return connector
      ? {
          ...withIcon,
          connectorId: connector.id,
          category: connector.category,
          title: connector.name
        }
      : withIcon
  })
}
