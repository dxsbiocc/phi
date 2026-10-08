import type {
  PackageRegistryEntryView,
  PackageTrust,
  PackageUpdateView
} from '../../../../../shared/packageManagerTypes'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import { isSemanticUpgrade, phiPluginDistributionLabel } from './phiPlugins'

export type PhiPluginCatalogEntry = PackageRegistryEntryView & {
  registryPath: string
  registryLabel?: string
  trust: PackageTrust
}

export type PhiPluginCatalogAction = 'install' | 'update' | 'installed'

export type PhiPluginCatalogItem = Pick<
  PhiPluginDisplayItem,
  'id' | 'title' | 'summary' | 'version' | 'icon' | 'trust'
> & {
  category: string
  source?: string
  entry?: PhiPluginCatalogEntry
}

export function buildPhiPluginCatalog(
  plugins: readonly PhiPluginDisplayItem[],
  entries: readonly PhiPluginCatalogEntry[]
): PhiPluginCatalogItem[] {
  const installed = new Map<string, PhiPluginDisplayItem>()
  for (const plugin of plugins) {
    const current = installed.get(plugin.id)
    if (!current || isSemanticUpgrade(current.version, plugin.version)) {
      installed.set(plugin.id, plugin)
    }
  }
  const available = new Map<string, PhiPluginCatalogEntry>()
  for (const entry of entries) {
    const current = available.get(entry.id)
    if (!current || isSemanticUpgrade(current.version, entry.version)) {
      available.set(entry.id, entry)
    }
  }
  const items: PhiPluginCatalogItem[] = [...available.values()].map((entry) => ({
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    version: entry.version,
    icon: entry.icon ?? installed.get(entry.id)?.icon,
    trust: entry.trust,
    category: entry.category?.trim() || '其他',
    source: entry.registryLabel,
    entry
  }))
  for (const plugin of installed.values()) {
    if (available.has(plugin.id)) continue
    items.push({
      id: plugin.id,
      title: plugin.title,
      summary: plugin.summary,
      version: plugin.version,
      icon: plugin.icon,
      trust: plugin.trust,
      category: '其他',
      source: phiPluginDistributionLabel(plugin.distribution)
    })
  }
  return items
}

export function filterPhiPluginCatalog(
  items: readonly PhiPluginCatalogItem[],
  category: string,
  query: string
): PhiPluginCatalogItem[] {
  const normalizedQuery = query.trim().toLowerCase()
  return items.filter((item) => {
    if (category !== 'all' && item.category !== category) return false
    return [item.title, item.id, item.version, item.summary, item.category].some((value) =>
      value.toLowerCase().includes(normalizedQuery)
    )
  })
}

export function phiPluginCatalogAction(
  entry: PhiPluginCatalogEntry,
  installedIds: ReadonlySet<string>,
  updates: readonly PackageUpdateView[]
): PhiPluginCatalogAction {
  if (updates.some((update) => update.type === 'plugin' && update.id === entry.id)) return 'update'
  return installedIds.has(entry.id) ? 'installed' : 'install'
}
