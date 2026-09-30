import type { SearxngEngineOption } from '../../../../../shared/webSearchSettingsTypes'

export function filterSearxngEngines(
  catalog: SearxngEngineOption[],
  query: string
): SearxngEngineOption[] {
  const term = query.trim().toLowerCase()
  if (!term) return catalog
  return catalog.filter(
    (engine) =>
      engine.name.toLowerCase().includes(term) || engine.shortcut?.toLowerCase().includes(term)
  )
}
