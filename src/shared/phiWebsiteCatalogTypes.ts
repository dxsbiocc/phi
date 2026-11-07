export type PhiWebsiteCatalogResult<T> =
  { status: 'available'; data: T } | { status: 'unavailable' }

export interface PhiCatalogPage<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

export interface PhiCatalogCategory {
  id: string
  label: string
  count: number
}

export interface PhiWrapperGroupsQuery {
  q?: string
  category?: string
  page?: number
  pageSize?: number
}

export interface PhiWrapperToolsQuery {
  group: string
  q?: string
  category?: string
  page?: number
  pageSize?: number
}

export interface PhiWrapperCatalogGroup {
  suite: string
  count: number
  category: string
  categories: Record<string, number>
  categoryLabel: string
}

export interface PhiWrapperGroupsPage extends PhiCatalogPage<PhiWrapperCatalogGroup> {
  view: 'groups'
  categories: PhiCatalogCategory[]
}

export interface PhiWrapperCatalogTool {
  id: string
  name: string
  summary?: string
  category: string
  categoryLabel: string
  path: string
  version: string
  source: string
  suite: string
}

export interface PhiWrapperToolsPage extends PhiCatalogPage<PhiWrapperCatalogTool> {
  view: 'tools'
  group: string
  suite: string
  categories: PhiCatalogCategory[]
}

export interface PhiWrapperCatalogParam {
  name: string
  kind?: string
  type?: string
  required?: boolean
  description?: string
}

export interface PhiWrapperCatalogSibling {
  id: string
  name: string
  tool: string
}

export interface PhiWrapperCatalogDetail {
  kind: 'wrapper'
  id: string
  name: string
  summary?: string
  category: string
  categoryLabel: string
  path: string
  version: string
  source: string
  suite?: string
  inputs: PhiWrapperCatalogParam[]
  outputs: PhiWrapperCatalogParam[]
  structure: {
    inputs: string[]
    process: string
    outputs: string[]
  }
  siblings: PhiWrapperCatalogSibling[]
}

export type PhiSkillGroupId = 'science' | 'nextflow' | 'meta' | 'other'

export interface PhiSkillGroupsQuery {
  q?: string
  page?: number
  pageSize?: number
}

export interface PhiSkillListQuery {
  group: PhiSkillGroupId
  q?: string
  page?: number
  pageSize?: number
}

export interface PhiSkillCatalogGroup {
  id: PhiSkillGroupId
  label: string
  count: number
}

export interface PhiSkillGroupsPage extends PhiCatalogPage<PhiSkillCatalogGroup> {
  view: 'groups'
}

export interface PhiSkillCatalogItem {
  id: string
  slug: string
  kind: 'skill'
  title: string
  description?: string
  path: string
  version: string
  sizeBytes?: number
  sizeLabel?: string
  source: string
  group: PhiSkillGroupId
  groupLabel: string
}

export interface PhiSkillListPage extends PhiCatalogPage<PhiSkillCatalogItem> {
  view: 'group'
  group: PhiSkillGroupId
  groupLabel: string
  groups: PhiSkillCatalogGroup[]
}

export type PhiCatalogFrontmatterValue =
  | string
  | number
  | boolean
  | null
  | PhiCatalogFrontmatterValue[]
  | { [key: string]: PhiCatalogFrontmatterValue }

export interface PhiSkillCatalogDetail {
  kind: 'skill'
  slug: string
  title: string
  description: string
  path: string
  version: string
  sizeBytes: number
  sizeLabel?: string
  source: string
  /** Trusted only as validated data; renderer must use the existing safe Markdown renderer. */
  markdown: string
  frontmatter: Record<string, PhiCatalogFrontmatterValue>
}
