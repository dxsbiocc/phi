import type {
  WrapperCompositionCatalogItem,
  WrapperCompositionManifest,
  WrapperCompositionParam
} from '../../../../../shared/wrapperCompositionManifestTypes'

export interface WrapperParamRow {
  name: string
  kind: WrapperCompositionParam['kind']
  type: string
  required: boolean
  description: string
  /** Human readable enum or numeric range, empty when the parameter is unconstrained. */
  constraint: string
}

const KIND_ORDER: Record<WrapperCompositionParam['kind'], number> = {
  input: 0,
  option: 1,
  output: 2
}

/** The wrappers a package supplies, matching how the catalog keys one choice per package. */
export function wrapperPackageMembers(
  catalog: readonly WrapperCompositionCatalogItem[],
  packageId: string
): WrapperCompositionCatalogItem[] {
  return catalog
    .filter((entry) => (entry.enablementId ?? entry.packageId ?? entry.id) === packageId)
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

export function wrapperParamRows(manifest: WrapperCompositionManifest): WrapperParamRow[] {
  return Object.entries(manifest.params)
    .map(([name, param]) => ({
      name,
      kind: param.kind,
      type: param.type,
      required: param.required,
      description: param.description ?? '',
      constraint: paramConstraint(param)
    }))
    .sort(
      (left, right) =>
        KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
        Number(right.required) - Number(left.required) ||
        left.name.localeCompare(right.name)
    )
}

function paramConstraint(param: WrapperCompositionParam): string {
  if (param.enum && param.enum.length > 0) return `可选值：${param.enum.join('、')}`
  if (param.minimum !== undefined || param.maximum !== undefined) {
    return `范围：${param.minimum ?? '−∞'} – ${param.maximum ?? '∞'}`
  }
  return ''
}
