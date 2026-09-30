import type { WebSearchProviderOption } from '../../../../../shared/webSearchSettingsTypes'

export type SearchProviderCostFilter = 'all' | WebSearchProviderOption['access']
export type SearchProviderEnabledFilter = 'all' | 'enabled' | 'disabled'

export function listSearchProviderPage(
  providers: WebSearchProviderOption[],
  enabledIds: string[],
  options: {
    cost: SearchProviderCostFilter
    enabled: SearchProviderEnabledFilter
    query: string
    page: number
    rowsPerPage: number
  }
): { rows: WebSearchProviderOption[]; total: number; page: number } {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]))
  const ordered = [
    ...enabledIds.flatMap((id) => {
      const provider = providerById.get(id)
      return provider ? [provider] : []
    }),
    ...providers.filter((provider) => !enabledIds.includes(provider.id))
  ]
  const term = options.query.trim().toLowerCase()
  const filtered = ordered.filter((provider) => {
    if (options.cost !== 'all' && provider.access !== options.cost) return false
    if (options.enabled === 'enabled' && !enabledIds.includes(provider.id)) return false
    if (options.enabled === 'disabled' && enabledIds.includes(provider.id)) return false
    return (
      !term ||
      `${provider.label} ${provider.id} ${provider.description}`.toLowerCase().includes(term)
    )
  })
  const rowsPerPage = Math.max(1, options.rowsPerPage)
  const page = Math.min(
    Math.max(0, options.page),
    Math.max(0, Math.ceil(filtered.length / rowsPerPage) - 1)
  )
  return {
    rows: filtered.slice(page * rowsPerPage, (page + 1) * rowsPerPage),
    total: filtered.length,
    page
  }
}
