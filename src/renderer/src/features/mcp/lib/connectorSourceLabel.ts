import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'
import { OFFICIAL_WEBSITE_HOST } from '../../../../../shared/officialWebsite'
import { resourceSourceLabel, resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from './connectorCopy'

/**
 * Name the provider behind a catalog source chip. Only official-catalog connectors with a
 * remote URL are refined: Phi-hosted endpoints stay "Phi Website", while vendor-hosted
 * endpoints name the publisher (or the URL host when no publisher is declared).
 */
export function connectorSourceLabel(connector: FeaturedMcpConnector): string {
  if (!connector.source) return ''

  const sourceLabel = resourceSourceLabel(connector.source.label)
  if (connector.source.kind !== 'official' || !connector.url) return sourceLabel

  let url: URL
  try {
    url = new URL(connector.url)
  } catch {
    return sourceLabel
  }

  if (url.hostname === OFFICIAL_WEBSITE_HOST) return resourceUi.officialWebsite
  return connectorCopy.publisherWebsite(connector.publisher.trim() || url.hostname)
}
