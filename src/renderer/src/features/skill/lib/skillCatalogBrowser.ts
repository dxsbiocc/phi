import semver from 'semver'
import type {
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import type { SkillSummary } from '../../../types'
import { CATALOG_DEFAULT_PAGE_SIZE } from '../../../components/catalog/catalogPaging'
import { registrySkillPackages } from './skillCatalog'

export type SkillCatalogPackage = PackageRegistryEntryView & { registryDir?: string }

export type SkillCatalogItem =
  | { kind: 'bundled'; groupId: 'bundled'; skill: SkillSummary }
  | { kind: 'package'; groupId: string; entry: SkillCatalogPackage }

export interface SkillCatalogGroup {
  id: string
  label: string
  count: number
}

export function knownSkillCatalogPackages(
  registries: readonly (PackageRegistryView | null)[]
): Array<SkillCatalogPackage & { registryDir: string }> {
  const selected = new Map<string, SkillCatalogPackage & { registryDir: string }>()
  for (const registry of registries) {
    if (!registry) continue
    for (const entry of registrySkillPackages(registry)) {
      const current = selected.get(entry.id)
      if (!current || semver.gt(entry.version, current.version)) {
        selected.set(entry.id, { ...entry, registryDir: registry.dir })
      }
    }
  }
  return [...selected.values()].sort((left, right) => left.title.localeCompare(right.title))
}

function packageCategory(entry: SkillCatalogPackage): string {
  return entry.category?.trim() || '本地软件包'
}

export function skillCatalogItems(
  bundledSkills: readonly SkillSummary[],
  packages: readonly SkillCatalogPackage[]
): SkillCatalogItem[] {
  return [
    ...bundledSkills.map((skill): SkillCatalogItem => ({
      kind: 'bundled',
      groupId: 'bundled',
      skill
    })),
    ...packages.map((entry): SkillCatalogItem => ({
      kind: 'package',
      groupId: `category:${packageCategory(entry)}`,
      entry
    }))
  ]
}

export function skillCatalogGroups(items: readonly SkillCatalogItem[]): SkillCatalogGroup[] {
  const categories = new Map<string, SkillCatalogGroup>()
  let bundledCount = 0
  for (const item of items) {
    if (item.kind === 'bundled') {
      bundledCount += 1
      continue
    }
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
    { id: 'bundled', label: '内置技能', count: bundledCount },
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
    const fields =
      item.kind === 'bundled'
        ? [item.skill.name, item.skill.description, item.skill.deprecated, '内置技能']
        : [item.entry.id, item.entry.title, item.entry.summary, packageCategory(item.entry)]
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
