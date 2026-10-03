import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import { phiPluginSourceCategoryOrder, type PhiPluginSourceCategory } from './phiPlugins'

export type PhiPluginGroup = {
  category: PhiPluginSourceCategory
  plugins: PhiPluginDisplayItem[]
}

export function groupPhiPlugins(plugins: readonly PhiPluginDisplayItem[]): PhiPluginGroup[] {
  return phiPluginSourceCategoryOrder
    .map((category) => ({
      category,
      plugins: plugins.filter((plugin) => plugin.distribution === category)
    }))
    .filter((group) => group.plugins.length > 0)
}

export function filterPhiPlugins(
  plugins: readonly PhiPluginDisplayItem[],
  query: string
): PhiPluginDisplayItem[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return [...plugins]
  return plugins.filter((plugin) =>
    [plugin.title, plugin.id, plugin.version, plugin.summary, plugin.directory]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(normalizedQuery))
  )
}

export function visiblePhiPluginCategory(
  groups: readonly PhiPluginGroup[],
  expandedCategory: PhiPluginSourceCategory | null,
  query: string
): PhiPluginSourceCategory | null {
  if (expandedCategory && groups.some((group) => group.category === expandedCategory)) {
    return expandedCategory
  }
  if (expandedCategory === null && !query.trim()) return null
  return groups[0]?.category ?? null
}
