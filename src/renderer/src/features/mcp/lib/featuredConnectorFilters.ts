import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'

export type ConnectorSignInFilter = 'all' | '无需登录' | '需要登录' | '需要 API key'
export type ConnectorInstallFilter = 'all' | 'added' | 'not-added'
export type ConnectorSort = 'default' | 'name' | 'added'

export function filterFeaturedConnectors(
  connectors: readonly FeaturedMcpConnector[],
  options: {
    category: string
    query: string
    signIn: ConnectorSignInFilter
    install: ConnectorInstallFilter
    sort: ConnectorSort
    isInstalled: (connector: FeaturedMcpConnector) => boolean
  }
): FeaturedMcpConnector[] {
  const query = options.query.trim().toLowerCase()
  const matched = connectors.filter((connector) => {
    if (query.length === 0 && connector.category !== options.category) return false
    if (options.signIn !== 'all' && connector.signIn !== options.signIn) return false
    const installed = options.isInstalled(connector)
    if (options.install === 'added' && !installed) return false
    if (options.install === 'not-added' && installed) return false
    if (!query) return true
    return [
      connector.name,
      connector.description,
      connector.overview,
      connector.category,
      connector.publisher
    ].some((value) => (value ?? '').toLowerCase().includes(query))
  })

  if (options.sort === 'name') {
    return [...matched].sort((left, right) => left.name.localeCompare(right.name, 'zh'))
  }
  if (options.sort === 'added') {
    return [...matched].sort(
      (left, right) => Number(options.isInstalled(right)) - Number(options.isInstalled(left))
    )
  }
  return matched
}
