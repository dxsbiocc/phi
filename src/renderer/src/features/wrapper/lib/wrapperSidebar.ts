import type {
  WrapperCompositionCatalogItem,
  WrapperCompositionManifest
} from '../../../../../shared/wrapperCompositionManifestTypes'
import { parseWrapperCompositionId, wrapperTierLabel } from './wrapperView'

/** Cached bundled packages stay discoverable without crowding the user's chosen resources. */
export function selectedWrappers(
  catalog: readonly WrapperCompositionCatalogItem[]
): WrapperCompositionCatalogItem[] {
  return catalog.filter((entry) => entry.packageSelected !== false)
}

export function filterWrappers<T extends WrapperCompositionManifest>(
  catalog: readonly T[],
  query: string
): T[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return [...catalog]
  return catalog.filter((entry) => {
    const { provider, tier, name } = parseWrapperCompositionId(entry.id)
    return [entry.id, entry.name, entry.summary, provider, tier, name, wrapperTierLabel(tier)].some(
      (value) => value.toLowerCase().includes(normalizedQuery)
    )
  })
}

export function visibleWrapperTier(
  groups: readonly { tier: string }[],
  expandedTier: string | null,
  query: string
): string | null {
  if (groups.some((group) => group.tier === expandedTier)) return expandedTier
  return query.trim() ? (groups[0]?.tier ?? null) : expandedTier
}
