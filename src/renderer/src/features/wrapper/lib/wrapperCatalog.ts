import semver from 'semver'

import type {
  InstalledPackageView,
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import { parseWrapperCompositionId, wrapperTierLabel } from './wrapperView'
import type { CatalogBrowseGroup } from '../../../components/catalog/CatalogBrowseLayout'
import { catalogPackages } from '../../../lib/contentCatalog'

export interface WrapperCatalogChoice {
  id: string
  title: string
  summary: string
  metadata: string
  category: string
  version?: string
  cached?: WrapperCompositionCatalogItem
  registryEntry?: PackageRegistryEntryView
  registryPath?: string
  /** Version of the payload shipped with the app; present until the user installs from a registry. */
  bundledVersion?: string
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
  const installed = new Map(
    installedPackages.filter((entry) => entry.type === 'wrapper').map((entry) => [entry.id, entry])
  )
  for (const entry of catalog) {
    const id = entry.enablementId ?? entry.packageId ?? entry.id
    if (choices.has(id)) continue
    const { provider, tier, name } = parseWrapperCompositionId(entry.id)
    choices.set(id, {
      id,
      title: name || entry.name,
      summary: entry.summary,
      metadata: provider,
      category: provider === 'custom' ? '自定义' : wrapperTierLabel(tier) || '其他',
      version: installed.get(id)?.version,
      bundledVersion: bundledVersionOf(installed.get(id)),
      cached: entry,
      installed: entry.packageSelected !== false,
      selected: entry.packageSelected !== false,
      enabled: entry.packageEnabled !== false
    })
  }
  for (const { entry, registry } of catalogPackages(registries, 'wrapper')) {
    const category = entry.category?.trim()
    const cached = choices.get(entry.id)
    if (cached) {
      if (category) cached.category = wrapperTierLabel(category)
      cached.registryEntry = entry
      cached.registryPath = registry.dir
      if (!cached.installed) {
        cached.title = entry.title
        cached.summary = entry.summary
        cached.metadata = registry.label ?? registry.id
        cached.version = entry.version
      }
      continue
    }
    const existing = installed.get(entry.id)
    const selected = Boolean(existing && existing.registry !== 'bundled-wrappers')
    choices.set(entry.id, {
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      metadata: registry.label ?? registry.id,
      version: selected ? existing?.version : entry.version,
      category: category
        ? wrapperTierLabel(category)
        : wrapperTierLabel(parseWrapperCompositionId(entry.id).tier) || '其他',
      registryEntry: entry,
      registryPath: registry.dir,
      bundledVersion: bundledVersionOf(existing),
      installed: selected,
      selected,
      enabled: selected && existing?.enabled !== false
    })
  }
  return [...choices.values()].sort((left, right) => left.title.localeCompare(right.title))
}

function bundledVersionOf(entry: InstalledPackageView | undefined): string | undefined {
  return entry?.registry === 'bundled-wrappers' ? entry.version : undefined
}

/**
 * A bundled payload that is not older than the catalog entry already is that package, so
 * choosing it only needs enabling. Planning an install would reject it as a downgrade or no-op.
 */
export function wrapperChoiceNeedsRegistryInstall(choice: WrapperCatalogChoice): boolean {
  if (choice.installed) return false
  const catalogVersion = choice.registryEntry?.version
  if (!choice.bundledVersion || !catalogVersion) return true
  return !(
    semver.valid(choice.bundledVersion) &&
    semver.valid(catalogVersion) &&
    semver.gte(choice.bundledVersion, catalogVersion)
  )
}

export function filterWrapperCatalogChoices(
  choices: readonly WrapperCatalogChoice[],
  query: string,
  groupId = 'all'
): WrapperCatalogChoice[] {
  const normalized = query.trim().toLowerCase()
  return choices.filter(
    (entry) =>
      (groupId === 'all' || groupId === `category:${entry.category}`) &&
      (!normalized ||
        [
          entry.id,
          entry.title,
          entry.summary,
          entry.metadata,
          entry.category,
          entry.version ?? ''
        ].some((value) => value.toLowerCase().includes(normalized)))
  )
}

export function wrapperCatalogGroups(
  choices: readonly WrapperCatalogChoice[]
): CatalogBrowseGroup[] {
  const counts = new Map<string, number>()
  for (const choice of choices) counts.set(choice.category, (counts.get(choice.category) ?? 0) + 1)
  const order = ['工作流', '子流程', '模块', '自定义', '其他']
  const rank = (label: string): number => {
    const index = order.indexOf(label)
    return index < 0 ? order.length : index
  }
  return [
    { id: 'all', label: '全部 Wrapper', count: choices.length },
    ...[...counts]
      .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
      .map(([label, count]) => ({ id: `category:${label}`, label, count }))
  ]
}
