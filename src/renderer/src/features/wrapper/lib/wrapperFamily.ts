import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import { parseWrapperCompositionId } from './wrapperView'

/** One tool family: a wrapper package shown as a single row (samtools, gatk4, rnaseq…). */
export interface WrapperPackageGroup {
  /** Enablement key shared by every member; custom wrappers fall back to their own id. */
  key: string
  name: string
  tier: string
  /** Wrappers of this package, sorted by id. */
  members: WrapperCompositionCatalogItem[]
  /** False only when the package is switched off. */
  enabled: boolean
  /** Whether the user can switch it (custom wrappers are always available). */
  managed: boolean
  /** The member to open: the one already open if it belongs here, otherwise the first. */
  open: (preferredId: string | null) => WrapperCompositionCatalogItem
}

const PACKAGE_ID = /^(?:module|subworkflow|workflow)-(?:nf-core|local)-(.+)$/

/** `module-nf-core-samtools` → `samtools`; ids that do not follow the convention are kept. */
export function wrapperFamilyName(packageId: string): string {
  return PACKAGE_ID.exec(packageId)?.[1] ?? packageId
}

/** Conventional package ids show as their tool; a lone custom wrapper keeps its own name. */
function displayName(
  key: string,
  members: readonly WrapperCompositionCatalogItem[],
  firstName: string
): string {
  if (PACKAGE_ID.test(key)) return wrapperFamilyName(key)
  return members.length === 1 ? firstName || members[0].name : key
}

export function groupWrapperPackages(
  catalog: readonly WrapperCompositionCatalogItem[]
): WrapperPackageGroup[] {
  const byKey = new Map<string, WrapperCompositionCatalogItem[]>()
  for (const entry of catalog) {
    const key = entry.enablementId ?? entry.packageId ?? entry.id
    byKey.set(key, [...(byKey.get(key) ?? []), entry])
  }
  const groups = [...byKey].map(([key, entries]) => {
    const members = [...entries].sort((left, right) => left.id.localeCompare(right.id))
    const managed = members.some((entry) => entry.enablementId ?? entry.packageId)
    const parsed = parseWrapperCompositionId(members[0].id)
    return {
      key,
      name: displayName(key, members, parsed.name),
      tier: parsed.tier,
      members,
      enabled: members.every((entry) => entry.packageEnabled !== false),
      managed,
      open: (preferredId: string | null) =>
        members.find((entry) => entry.id === preferredId) ?? members[0]
    }
  })
  return groups.sort(
    (left, right) =>
      Number(right.managed) - Number(left.managed) || left.name.localeCompare(right.name)
  )
}

/** The wrapper's own name inside its family: `samtools-sort` in `samtools` shows as `sort`. */
export function wrapperToolLabel(familyName: string, wrapperId: string): string {
  const { name } = parseWrapperCompositionId(wrapperId)
  const prefix = `${familyName}-`
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name
}
