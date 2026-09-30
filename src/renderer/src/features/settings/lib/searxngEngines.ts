import type { SearxngEngineOption } from '../../../../../shared/webSearchSettingsTypes'
import { SEARXNG_UPSTREAM_ENGINES } from './searxngUpstreamCatalog'

export type SearxngDisplayEngine = SearxngEngineOption & {
  inactive?: boolean
  available?: boolean
}

// Keep the requested Sogou examples visible first; the full upstream catalog
// follows in its original order and remains searchable.
const sogouNames = new Set(['sogou', 'sogou images', 'sogou videos', 'sogou wechat'])
const orderedUpstream = [
  ...SEARXNG_UPSTREAM_ENGINES.filter(([name]) => sogouNames.has(name)),
  ...SEARXNG_UPSTREAM_ENGINES.filter(([name]) => !sogouNames.has(name))
]

export const SEARXNG_DEFAULT_ENGINES: SearxngDisplayEngine[] = orderedUpstream.map(
  ([name, shortcut, disabled, inactive]) => ({
    name,
    ...(shortcut ? { shortcut } : {}),
    categories: [],
    enabled: !disabled && !inactive,
    inactive
  })
)

export function mergeSearxngEngines(instance: SearxngEngineOption[]): SearxngDisplayEngine[] {
  const instanceByName = new Map(instance.map((engine) => [engine.name.toLowerCase(), engine]))
  const upstreamNames = new Set(SEARXNG_DEFAULT_ENGINES.map((engine) => engine.name.toLowerCase()))
  return [
    ...SEARXNG_DEFAULT_ENGINES.map((engine) => {
      const installed = instanceByName.get(engine.name.toLowerCase())
      return installed
        ? { ...installed, available: true, inactive: false }
        : { ...engine, available: false }
    }),
    ...instance
      .filter((engine) => !upstreamNames.has(engine.name.toLowerCase()))
      .map((engine) => ({
        ...engine,
        available: true,
        inactive: false
      }))
  ]
}

export function filterSearxngEngines<T extends SearxngEngineOption>(
  catalog: T[],
  query: string
): T[] {
  const term = query.trim().toLowerCase()
  if (!term) return catalog
  return catalog.filter(
    (engine) =>
      engine.name.toLowerCase().includes(term) || engine.shortcut?.toLowerCase().includes(term)
  )
}

export type SearxngSelectionFilter = 'all' | 'selected' | 'unselected' | 'unavailable'
export type SearxngStatusFilter =
  'all' | 'default-on' | 'default-off' | 'admin-required' | 'instance-missing'

export function isSearxngEngineUnavailable(engine: SearxngDisplayEngine): boolean {
  return Boolean(engine.inactive || engine.available === false)
}

export function listSearxngEnginePage(
  catalog: SearxngDisplayEngine[],
  options: {
    query: string
    selection: SearxngSelectionFilter
    status: SearxngStatusFilter
    selectedNames: Set<string>
    page: number
    rowsPerPage: number
    nameOrder: 'original' | 'asc' | 'desc'
  }
): { rows: SearxngDisplayEngine[]; total: number; page: number } {
  const filtered = filterSearxngEngines(catalog, options.query).filter((engine) => {
    const unavailable = isSearxngEngineUnavailable(engine)
    const selected = options.selectedNames.has(engine.name)
    const matchesSelection =
      options.selection === 'all' ||
      (options.selection === 'unavailable'
        ? unavailable
        : !unavailable && (options.selection === 'selected' ? selected : !selected))
    if (!matchesSelection) return false
    switch (options.status) {
      case 'all':
        return true
      case 'default-on':
        return !unavailable && engine.enabled
      case 'default-off':
        return !unavailable && !engine.enabled
      case 'admin-required':
        return Boolean(engine.inactive)
      case 'instance-missing':
        return engine.available === false
    }
  })
  if (options.nameOrder !== 'original') {
    filtered.sort((left, right) =>
      options.nameOrder === 'asc'
        ? left.name.localeCompare(right.name)
        : right.name.localeCompare(left.name)
    )
  }
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

export function toggleSearxngEngine(
  selected: string[],
  defaultEnabled: string[],
  name: string
): string | null {
  const effective = selected.length ? selected : defaultEnabled
  const next = effective.includes(name)
    ? effective.filter((item) => item !== name)
    : [...effective, name]
  if (!next.length) return null
  const matchesDefault =
    next.length === defaultEnabled.length && defaultEnabled.every((item) => next.includes(item))
  return matchesDefault ? '' : next.join(',')
}
