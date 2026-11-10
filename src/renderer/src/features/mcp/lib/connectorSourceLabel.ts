import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import { OFFICIAL_WEBSITE_HOST } from '../../../../../shared/officialWebsite'
import { resourceSourceLabel, resourceUi } from '../../../lib/resourceUi'

/**
 * Name the provider behind a catalog source chip. Only official-catalog connectors are
 * refined: Phi-hosted endpoints read "Phi", while vendor-hosted endpoints name the publisher
 * (or the URL host when no publisher is declared).
 */
export function connectorSourceLabel(connector: FeaturedMcpConnector): string {
  if (!connector.source) return ''

  const sourceLabel = resourceSourceLabel(connector.source.label)
  if (connector.source.kind !== 'official') return sourceLabel
  if (!connector.url) return resourceUi.officialSource

  let url: URL
  try {
    url = new URL(connector.url)
  } catch {
    return resourceUi.officialSource
  }

  if (url.hostname === OFFICIAL_WEBSITE_HOST) return resourceUi.officialSource
  return connector.publisher.trim() || url.hostname
}
