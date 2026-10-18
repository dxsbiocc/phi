import { wrapperCopy } from './wrapperCopy'
import type {
  WrapperCompositionCatalogItem,
  WrapperCompositionManifest,
  WrapperCompositionParam
} from '../../../../../shared/wrapperCompositionManifestTypes'
import { wrapperPackageKey } from './wrapperFamily'

/** The wrappers a package supplies, matching how the catalog keys one choice per package. */
export function wrapperPackageMembers(
  catalog: readonly WrapperCompositionCatalogItem[],
  packageId: string
): WrapperCompositionCatalogItem[] {
  return catalog
    .filter((entry) => wrapperPackageKey(entry) === packageId)
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function filterWrapperMembers<T extends WrapperCompositionManifest>(
  members: readonly T[],
  query: string
): T[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...members]
  return members.filter((entry) =>
    [entry.name, entry.id, entry.summary].some((value) => value.toLowerCase().includes(normalized))
  )
}

/** Human readable enum or numeric range, empty when the parameter is unconstrained. */
export function wrapperParamConstraint(param: WrapperCompositionParam): string {
  if (param.enum && param.enum.length > 0) return wrapperCopy.enumValues(param.enum)
  if (param.minimum !== undefined || param.maximum !== undefined) {
    return wrapperCopy.numericRange(param.minimum, param.maximum)
  }
  return ''
}
