import { isRecord } from '../../../shared/guards'
import type {
  PhiCatalogCategory,
  PhiCatalogFrontmatterValue,
  PhiCatalogPage,
  PhiSkillCatalogDetail,
  PhiSkillCatalogGroup,
  PhiSkillCatalogItem,
  PhiSkillGroupId,
  PhiSkillGroupsPage,
  PhiSkillGroupsQuery,
  PhiSkillListPage,
  PhiSkillListQuery,
  PhiWebsiteCatalogResult,
  PhiWrapperCatalogDetail,
  PhiWrapperCatalogGroup,
  PhiWrapperCatalogParam,
  PhiWrapperCatalogTool,
  PhiWrapperGroupsPage,
  PhiWrapperGroupsQuery,
  PhiWrapperToolsPage,
  PhiWrapperToolsQuery
} from '../../../shared/phiWebsiteCatalogTypes'
import {
  fetchOfficialWebsiteJson,
  type OfficialWebsiteRequestOptions
} from './official-website-transport'

const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_PAGE_ITEMS = 100
const MAX_DETAIL_ITEMS = 256
const MAX_CATEGORIES = 32
const MAX_MARKDOWN = 512 * 1024
const SKILL_GROUPS = new Set<PhiSkillGroupId>(['science', 'nextflow', 'meta', 'other'])
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

const limit = {
  identifier: 160,
  id: 1_024,
  title: 240,
  summary: 8_000,
  path: 4_096,
  version: 128,
  source: 160,
  label: 240,
  frontmatter: 4_096
} as const

export async function getOfficialWebsiteWrapperGroups(
  query: PhiWrapperGroupsQuery = {},
  options: OfficialWebsiteRequestOptions = {}
): Promise<PhiWebsiteCatalogResult<PhiWrapperGroupsPage>> {
  if (!isRecord(query)) return { status: 'unavailable' }
  return requestCatalog(
    '/api/wrappers',
    { ...query, view: 'groups' },
    (value) => wrapperGroupsPage(value),
    options
  )
}

export async function getOfficialWebsiteWrapperTools(
  query: PhiWrapperToolsQuery,
  options: OfficialWebsiteRequestOptions = {}
): Promise<PhiWebsiteCatalogResult<PhiWrapperToolsPage>> {
  if (!isRecord(query)) return { status: 'unavailable' }
  return requestCatalog('/api/wrappers', query, (value) => wrapperToolsPage(value, query), options)
}

export async function getOfficialWebsiteWrapperDetail(
  id: string,
  options: OfficialWebsiteRequestOptions = {}
): Promise<PhiWebsiteCatalogResult<PhiWrapperCatalogDetail>> {
  if (!safeWrapperId(id)) return { status: 'unavailable' }
  return requestCatalog(
    `/api/wrappers/${id.split('/').map(encodeURIComponent).join('/')}`,
    undefined,
    (value) => wrapperDetail(value, id),
    options
  )
}

export async function getOfficialWebsiteSkillGroups(
  query: PhiSkillGroupsQuery = {},
  options: OfficialWebsiteRequestOptions = {}
): Promise<PhiWebsiteCatalogResult<PhiSkillGroupsPage>> {
  if (!isRecord(query)) return { status: 'unavailable' }
  return requestCatalog(
    '/api/skills',
    { ...query, view: 'groups' },
    (value) => skillGroupsPage(value),
    options
  )
}

export async function getOfficialWebsiteSkills(
  query: PhiSkillListQuery,
  options: OfficialWebsiteRequestOptions = {}
): Promise<PhiWebsiteCatalogResult<PhiSkillListPage>> {
  if (!isRecord(query)) return { status: 'unavailable' }
  return requestCatalog('/api/skills', query, (value) => skillListPage(value, query), options)
}

export async function getOfficialWebsiteSkillDetail(
  slug: string,
  options: OfficialWebsiteRequestOptions = {}
): Promise<PhiWebsiteCatalogResult<PhiSkillCatalogDetail>> {
  if (!safeSlug(slug)) return { status: 'unavailable' }
  return requestCatalog(
    `/api/skills/${encodeURIComponent(slug)}`,
    undefined,
    (value) => skillDetail(value, slug),
    options
  )
}

async function requestCatalog<T>(
  path: string,
  query: object | undefined,
  validate: (value: unknown) => T,
  options: OfficialWebsiteRequestOptions
): Promise<PhiWebsiteCatalogResult<T>> {
  try {
    const suffix = query ? catalogQuery(query) : ''
    const value = await fetchOfficialWebsiteJson(`${path}${suffix}`, MAX_RESPONSE_BYTES, options)
    return { status: 'available', data: validate(value) }
  } catch {
    return { status: 'unavailable' }
  }
}

function catalogQuery(query: object): string {
  if (!isRecord(query)) throw new Error('catalog query must be an object')
  const params = new URLSearchParams()
  for (const key of ['view', 'group', 'q', 'category'] as const) {
    addStringQueryParam(params, query, key)
  }
  for (const key of ['page', 'pageSize'] as const) {
    addNumberQueryParam(params, query, key)
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

function addStringQueryParam(
  params: URLSearchParams,
  query: Record<string, unknown>,
  key: 'view' | 'group' | 'q' | 'category'
): void {
  const value = query[key]
  if (value === undefined || value === '') return
  if (typeof value !== 'string' || value.length > 1_000) throw new Error(`invalid ${key}`)
  if ((key === 'group' || key === 'category') && !safeSegment(value)) {
    throw new Error(`invalid ${key}`)
  }
  params.set(key, value)
}

function addNumberQueryParam(
  params: URLSearchParams,
  query: Record<string, unknown>,
  key: 'page' | 'pageSize'
): void {
  const value = query[key]
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100_000) {
    throw new Error(`invalid ${key}`)
  }
  if (key === 'pageSize' && (value as number) > MAX_PAGE_ITEMS) throw new Error('invalid pageSize')
  params.set(key, String(value))
}

function wrapperGroupsPage(value: unknown): PhiWrapperGroupsPage {
  const row = record(value, 'wrapper groups')
  if (row.view !== 'groups') throw new Error('invalid wrapper groups view')
  return {
    view: 'groups',
    ...page(row, wrapperGroup),
    categories: array(row.categories, 'categories', MAX_CATEGORIES).map(category)
  }
}

function wrapperToolsPage(value: unknown, query: PhiWrapperToolsQuery): PhiWrapperToolsPage {
  if (!isRecord(query) || !safeSegment(query.group)) throw new Error('invalid wrapper group')
  const row = record(value, 'wrapper tools')
  if (row.view !== 'tools' || row.group !== query.group || row.suite !== query.group) {
    throw new Error('wrapper group does not match request')
  }
  return {
    view: 'tools',
    group: query.group,
    suite: query.group,
    ...page(row, wrapperTool),
    categories: array(row.categories, 'categories', MAX_CATEGORIES).map(category)
  }
}

function wrapperGroup(value: unknown, index: number): PhiWrapperCatalogGroup {
  const row = record(value, `items[${index}]`)
  const categories = categoryCounts(row.categories, `items[${index}].categories`)
  return {
    suite: segment(row.suite, `items[${index}].suite`),
    count: count(row.count, `items[${index}].count`),
    category: segment(row.category, `items[${index}].category`),
    categories,
    categoryLabel: text(row.categoryLabel, `items[${index}].categoryLabel`, limit.label)
  }
}

function wrapperTool(value: unknown, index: number): PhiWrapperCatalogTool {
  const row = record(value, `items[${index}]`)
  const id = wrapperId(row.id, `items[${index}].id`)
  const summary = optionalText(row.summary, `items[${index}].summary`, limit.summary)
  return {
    id,
    name: text(row.name, `items[${index}].name`, limit.title),
    ...(summary === undefined ? {} : { summary }),
    category: segment(row.category, `items[${index}].category`),
    categoryLabel: text(row.categoryLabel, `items[${index}].categoryLabel`, limit.label),
    path: text(row.path, `items[${index}].path`, limit.path),
    version: text(row.version, `items[${index}].version`, limit.version),
    source: text(row.source, `items[${index}].source`, limit.source),
    suite: segment(row.suite, `items[${index}].suite`)
  }
}

function wrapperDetail(value: unknown, requestedId: string): PhiWrapperCatalogDetail {
  const row = record(value, 'wrapper detail')
  if (row.kind !== 'wrapper' || row.id !== requestedId) throw new Error('wrapper detail mismatch')
  const summary = optionalText(row.summary, 'summary', limit.summary)
  const suite = optionalSegment(row.suite, 'suite')
  const structure = record(row.structure, 'structure')
  return {
    kind: 'wrapper',
    id: wrapperId(row.id, 'id'),
    name: text(row.name, 'name', limit.title),
    ...(summary === undefined ? {} : { summary }),
    category: segment(row.category, 'category'),
    categoryLabel: text(row.categoryLabel, 'categoryLabel', limit.label),
    path: text(row.path, 'path', limit.path),
    version: text(row.version, 'version', limit.version),
    source: text(row.source, 'source', limit.source),
    ...(suite === undefined ? {} : { suite }),
    inputs: array(row.inputs, 'inputs', MAX_DETAIL_ITEMS).map(wrapperParam),
    outputs: array(row.outputs, 'outputs', MAX_DETAIL_ITEMS).map(wrapperParam),
    structure: {
      inputs: stringList(structure.inputs, 'structure.inputs', MAX_DETAIL_ITEMS),
      process: text(structure.process, 'structure.process', limit.title),
      outputs: stringList(structure.outputs, 'structure.outputs', MAX_DETAIL_ITEMS)
    },
    siblings: array(row.siblings, 'siblings', MAX_DETAIL_ITEMS).map((entry, index) => {
      const sibling = record(entry, `siblings[${index}]`)
      return {
        id: wrapperId(sibling.id, `siblings[${index}].id`),
        name: text(sibling.name, `siblings[${index}].name`, limit.title),
        tool: text(sibling.tool, `siblings[${index}].tool`, limit.title)
      }
    })
  }
}

function wrapperParam(value: unknown, index: number): PhiWrapperCatalogParam {
  const row = record(value, `params[${index}]`)
  const kind = optionalText(row.kind, `params[${index}].kind`, limit.identifier)
  const type = optionalText(row.type, `params[${index}].type`, limit.identifier)
  const description = optionalText(row.description, `params[${index}].description`, limit.summary)
  if (row.required !== undefined && typeof row.required !== 'boolean') {
    throw new Error(`params[${index}].required must be a boolean`)
  }
  return {
    name: text(row.name, `params[${index}].name`, limit.identifier),
    ...(kind === undefined ? {} : { kind }),
    ...(type === undefined ? {} : { type }),
    ...(row.required === undefined ? {} : { required: row.required }),
    ...(description === undefined ? {} : { description })
  }
}

function skillGroupsPage(value: unknown): PhiSkillGroupsPage {
  const row = record(value, 'skill groups')
  if (row.view !== 'groups') throw new Error('invalid skill groups view')
  return { view: 'groups', ...page(row, skillGroup) }
}

function skillListPage(value: unknown, query: PhiSkillListQuery): PhiSkillListPage {
  if (!isRecord(query) || !skillGroupId(query.group)) throw new Error('invalid skill group')
  const row = record(value, 'skill list')
  if (row.view !== 'group' || row.group !== query.group) throw new Error('skill group mismatch')
  return {
    view: 'group',
    group: query.group,
    groupLabel: text(row.groupLabel, 'groupLabel', limit.label),
    ...page(row, (entry, index) => skillItem(entry, index, query.group)),
    groups: array(row.groups, 'groups', MAX_CATEGORIES).map(skillGroup)
  }
}

function skillGroup(value: unknown, index: number): PhiSkillCatalogGroup {
  const row = record(value, `groups[${index}]`)
  return {
    id: requiredSkillGroup(row.id, `groups[${index}].id`),
    label: text(row.label, `groups[${index}].label`, limit.label),
    count: count(row.count, `groups[${index}].count`)
  }
}

function skillItem(value: unknown, index: number, group: PhiSkillGroupId): PhiSkillCatalogItem {
  const row = record(value, `items[${index}]`)
  if (row.kind !== 'skill' || row.group !== group) throw new Error('invalid skill item kind/group')
  const slug = slugValue(row.slug, `items[${index}].slug`)
  if (row.id !== slug) throw new Error('skill item id does not match slug')
  const description = optionalText(row.description, `items[${index}].description`, limit.summary)
  const sizeBytes = optionalCount(row.sizeBytes, `items[${index}].sizeBytes`)
  const sizeLabel = optionalText(row.sizeLabel, `items[${index}].sizeLabel`, limit.label)
  return {
    id: slug,
    slug,
    kind: 'skill',
    title: text(row.title, `items[${index}].title`, limit.title),
    ...(description === undefined ? {} : { description }),
    path: text(row.path, `items[${index}].path`, limit.path),
    version: text(row.version, `items[${index}].version`, limit.version),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(sizeLabel === undefined ? {} : { sizeLabel }),
    source: text(row.source, `items[${index}].source`, limit.source),
    group,
    groupLabel: text(row.groupLabel, `items[${index}].groupLabel`, limit.label)
  }
}

function skillDetail(value: unknown, requestedSlug: string): PhiSkillCatalogDetail {
  const row = record(value, 'skill detail')
  if (row.kind !== 'skill' || row.slug !== requestedSlug) throw new Error('skill detail mismatch')
  const sizeLabel = optionalText(row.sizeLabel, 'sizeLabel', limit.label)
  if (typeof row.markdown !== 'string') throw new Error('markdown must be a string')
  return {
    kind: 'skill',
    slug: slugValue(row.slug, 'slug'),
    title: text(row.title, 'title', limit.title),
    description: text(row.description, 'description', limit.summary),
    path: text(row.path, 'path', limit.path),
    version: text(row.version, 'version', limit.version),
    sizeBytes: count(row.sizeBytes, 'sizeBytes'),
    ...(sizeLabel === undefined ? {} : { sizeLabel }),
    source: text(row.source, 'source', limit.source),
    markdown: row.markdown.replace(/\0/g, '').slice(0, MAX_MARKDOWN),
    frontmatter: frontmatterObject(row.frontmatter, 'frontmatter')
  }
}

function page<T>(
  row: Record<string, unknown>,
  item: (value: unknown, index: number) => T
): PhiCatalogPage<T> {
  const total = count(row.total, 'total')
  const currentPage = positiveInteger(row.page, 'page')
  const pageSize = positiveInteger(row.pageSize, 'pageSize')
  const pageCount = positiveInteger(row.pageCount, 'pageCount')
  if (pageSize > MAX_PAGE_ITEMS || pageCount !== Math.max(1, Math.ceil(total / pageSize))) {
    throw new Error('invalid catalog pagination')
  }
  const items = array(row.items, 'items', MAX_PAGE_ITEMS)
  if (
    currentPage > pageCount ||
    items.length > pageSize ||
    items.length > total ||
    (total === 0 && items.length !== 0) ||
    (total > 0 && currentPage < pageCount && items.length !== pageSize) ||
    (total > 0 && currentPage === pageCount && items.length !== total - (pageCount - 1) * pageSize)
  ) {
    throw new Error('catalog page item count is inconsistent')
  }
  return { items: items.map(item), total, page: currentPage, pageSize, pageCount }
}

function category(value: unknown, index: number): PhiCatalogCategory {
  const row = record(value, `categories[${index}]`)
  return {
    id: segment(row.id, `categories[${index}].id`),
    label: text(row.label, `categories[${index}].label`, limit.label),
    count: count(row.count, `categories[${index}].count`)
  }
}

function categoryCounts(value: unknown, path: string): Record<string, number> {
  const row = record(value, path)
  return Object.fromEntries(
    Object.entries(row)
      .slice(0, MAX_CATEGORIES)
      .map(([key, value]) => [segment(key, `${path}.${key}`), count(value, `${path}.${key}`)])
  )
}

function frontmatterObject(
  value: unknown,
  path: string
): Record<string, PhiCatalogFrontmatterValue> {
  const row = record(value, path)
  return Object.fromEntries(
    Object.entries(row)
      .slice(0, 128)
      .map(([key, entry]) => [
        key.slice(0, limit.identifier),
        frontmatterValue(entry, `${path}.${key}`, 1)
      ])
  )
}

function frontmatterValue(value: unknown, path: string, depth: number): PhiCatalogFrontmatterValue {
  if (depth > 8) throw new Error(`${path} is too deeply nested`)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.replace(/\0/g, '').slice(0, limit.frontmatter)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value))
    return value
      .slice(0, 128)
      .map((item, index) => frontmatterValue(item, `${path}[${index}]`, depth + 1))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 128)
        .map(([key, entry]) => [
          key.slice(0, limit.identifier),
          frontmatterValue(entry, `${path}.${key}`, depth + 1)
        ])
    )
  }
  throw new Error(`${path} contains an invalid value`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  return value
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value.slice(0, max)
}

function stringList(value: unknown, path: string, max: number): string[] {
  return array(value, path, max).map((entry, index) =>
    text(entry, `${path}[${index}]`, limit.identifier)
  )
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
    })
    .join('')
    .slice(0, max)
}

function optionalText(value: unknown, path: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, path, max)
}

function count(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw new Error(`${path} must be a non-negative integer`)
  }
  return value as number
}

function optionalCount(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : count(value, path)
}

function positiveInteger(value: unknown, path: string): number {
  const result = count(value, path)
  if (result < 1) throw new Error(`${path} must be positive`)
  return result
}

function safeSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length <= limit.identifier && SAFE_SEGMENT.test(value)
}

function segment(value: unknown, path: string): string {
  if (!safeSegment(value)) throw new Error(`${path} is invalid`)
  return value
}

function optionalSegment(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : segment(value, path)
}

function safeWrapperId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= limit.id && value.split('/').every(safeSegment)
  )
}

function wrapperId(value: unknown, path: string): string {
  if (!safeWrapperId(value)) throw new Error(`${path} is invalid`)
  return value
}

function safeSlug(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= limit.identifier && /^[a-z][a-z0-9-]*$/.test(value)
  )
}

function slugValue(value: unknown, path: string): string {
  if (!safeSlug(value)) throw new Error(`${path} is invalid`)
  return value
}

function skillGroupId(value: unknown): value is PhiSkillGroupId {
  return typeof value === 'string' && SKILL_GROUPS.has(value as PhiSkillGroupId)
}

function requiredSkillGroup(value: unknown, path: string): PhiSkillGroupId {
  if (!skillGroupId(value)) throw new Error(`${path} is invalid`)
  return value
}
