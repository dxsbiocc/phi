import type {
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import { CATALOG_DEFAULT_PAGE_SIZE } from '../../../components/catalog/catalogPaging'
import { catalogPackages } from '../../../lib/contentCatalog'

export type SkillCatalogPackage = PackageRegistryEntryView & {
  registryDir?: string
  registryLabel?: string
}

export type SkillCatalogItem = { kind: 'package'; groupId: string; entry: SkillCatalogPackage }

export interface SkillCatalogGroup {
  id: string
  label: string
  count: number
}

export function knownSkillCatalogPackages(
  registries: readonly (PackageRegistryView | null)[]
): Array<SkillCatalogPackage & { registryDir: string }> {
  return catalogPackages(registries, 'skill').map(({ entry, registry }) => ({
    ...entry,
    registryDir: registry.dir,
    registryLabel: registry.label ?? registry.id
  }))
}

function packageCategory(entry: SkillCatalogPackage): string {
  return entry.category?.trim() || '软件包'
}

export function skillCatalogItems(packages: readonly SkillCatalogPackage[]): SkillCatalogItem[] {
  return packages.map((entry): SkillCatalogItem => ({
    kind: 'package',
    groupId: `category:${packageCategory(entry)}`,
    entry
  }))
}

export function skillCatalogGroups(items: readonly SkillCatalogItem[]): SkillCatalogGroup[] {
  const categories = new Map<string, SkillCatalogGroup>()
  for (const item of items) {
    const current = categories.get(item.groupId)
    if (current) current.count += 1
    else
      categories.set(item.groupId, {
        id: item.groupId,
        label: packageCategory(item.entry),
        count: 1
      })
  }
  return [
    { id: 'all', label: '全部技能', count: items.length },
    ...[...categories.values()].sort((left, right) =>
      left.label.localeCompare(right.label, 'zh-CN')
    )
  ]
}

export function filterSkillCatalogItems(
  items: readonly SkillCatalogItem[],
  groupId: string,
  query: string
): SkillCatalogItem[] {
  const needle = query.trim().toLocaleLowerCase()
  return items.filter((item) => {
    if (groupId !== 'all' && item.groupId !== groupId) return false
    if (!needle) return true
    const fields = [
      item.entry.id,
      item.entry.title,
      item.entry.summary,
      packageCategory(item.entry),
      item.entry.registryLabel
    ]
    return fields.some((field) => field?.toLocaleLowerCase().includes(needle))
  })
}

export interface SkillCatalogBrowserState {
  groupId: string
  query: string
  page: number
  rowsPerPage: number
}

export type SkillCatalogBrowserAction =
  | { type: 'group'; groupId: string }
  | { type: 'query'; query: string }
  | { type: 'reconcile'; groupIds: readonly string[]; ready: boolean; page: number }
  | { type: 'page'; page: number }
  | { type: 'page-size'; rowsPerPage: number }
  | { type: 'close' }

export const initialSkillCatalogBrowserState: SkillCatalogBrowserState = {
  groupId: 'all',
  query: '',
  page: 0,
  rowsPerPage: CATALOG_DEFAULT_PAGE_SIZE
}

export function skillCatalogBrowserReducer(
  state: SkillCatalogBrowserState,
  action: SkillCatalogBrowserAction
): SkillCatalogBrowserState {
  switch (action.type) {
    case 'group':
      return { ...state, groupId: action.groupId, page: 0 }
    case 'query':
      return { ...state, query: action.query, page: 0 }
    case 'reconcile':
      if (!action.ready) return state
      if (!action.groupIds.includes(state.groupId)) return { ...state, groupId: 'all', page: 0 }
      return state.page === action.page ? state : { ...state, page: action.page }
    case 'page':
      return { ...state, page: action.page }
    case 'page-size':
      return { ...state, rowsPerPage: action.rowsPerPage, page: 0 }
    case 'close':
      return initialSkillCatalogBrowserState
  }
}
