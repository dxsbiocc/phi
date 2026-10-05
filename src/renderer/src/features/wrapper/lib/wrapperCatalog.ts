import semver from 'semver'
import type {
  InstalledPackageView,
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import { parseWrapperCompositionId, wrapperTierLabel } from './wrapperView'

export interface WrapperCatalogChoice {
  id: string
  title: string
  summary: string
  metadata: string
  cached?: WrapperCompositionCatalogItem
  registryEntry?: PackageRegistryEntryView
  registryPath?: string
  installed: boolean
  selected: boolean
  enabled: boolean
}

/** One choice per package: several wrappers supplied by it share the same switch. */
export function wrapperCatalogChoices(
  catalog: readonly WrapperCompositionCatalogItem[],
  registries: readonly PackageRegistryView[],
  installedPackages: readonly InstalledPackageView[] = []
): WrapperCatalogChoice[] {
  const choices = new Map<string, WrapperCatalogChoice>()
  for (const entry of catalog) {
    const id = entry.enablementId ?? entry.packageId ?? entry.id
    if (choices.has(id)) continue
    const { provider, tier, name } = parseWrapperCompositionId(entry.id)
    choices.set(id, {
      id,
      title: name || entry.name,
      summary: entry.summary,
      metadata: `${provider} · ${wrapperTierLabel(tier)}`,
      cached: entry,
      installed: true,
      selected: entry.packageSelected !== false,
      enabled: entry.packageEnabled !== false
    })
  }
  const installed = new Map(
    installedPackages.filter((entry) => entry.type === 'wrapper').map((entry) => [entry.id, entry])
  )
  const packages = new Map<string, { entry: PackageRegistryEntryView; path: string }>()
  for (const registry of registries) {
    for (const entry of registry.packages) {
      if (entry.type !== 'wrapper') continue
      const current = packages.get(entry.id)
      if (!current || semver.gt(entry.version, current.entry.version)) {
        packages.set(entry.id, { entry, path: registry.dir })
      }
    }
  }
  for (const { entry, path } of packages.values()) {
    if (choices.has(entry.id)) continue
    const existing = installed.get(entry.id)
    const selected = Boolean(existing && existing.registry !== 'bundled-wrappers')
    choices.set(entry.id, {
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      metadata: entry.category ?? `v${entry.version}`,
      registryEntry: entry,
      registryPath: path,
      installed: Boolean(existing),
      selected,
      enabled: selected && existing?.enabled !== false
    })
  }
  return [...choices.values()].sort((left, right) => left.title.localeCompare(right.title))
}

export function filterWrapperCatalogChoices(
  choices: readonly WrapperCatalogChoice[],
  query: string
): WrapperCatalogChoice[] {
  const normalized = query.trim().toLowerCase()
  return normalized
    ? choices.filter((entry) =>
        [entry.id, entry.title, entry.summary, entry.metadata].some((value) =>
          value.toLowerCase().includes(normalized)
        )
      )
    : [...choices]
}
