import type { PackageType } from './manifest'

import { isRecord } from '../../../shared/guards'
import {
  fetchOfficialWebsiteJson,
  OFFICIAL_WEBSITE_BASE_URL,
  type OfficialWebsiteRequestOptions
} from './official-website-transport'

export const OFFICIAL_CATALOG_BASE_URL = OFFICIAL_WEBSITE_BASE_URL
const ROUTES: Record<PackageType, string> = {
  skill: '/api/skills',
  mcp: '/api/mcp',
  plugin: '/api/plugins',
  wrapper: '/api/wrappers'
}
const MAX_PAGE_BYTES = 1024 * 1024
const PAGE_SIZE = 100
const MAX_PAGES = 5
const DEFAULT_TIMEOUT_MS = 10_000
const PACKAGE_ID = /^[a-z][a-z0-9-]{1,63}$/
const WRAPPER_KINDS = {
  modules: 'module',
  subworkflows: 'subworkflow',
  workflows: 'workflow'
} as const

export type OfficialCatalogApiOptions = Omit<OfficialWebsiteRequestOptions, 'signal'>

export interface OfficialCatalogSearchResult {
  matches: Array<{ type: PackageType; id: string }>
  available: boolean
  notice?: string
}

interface CatalogPage {
  items: Record<string, unknown>[]
  pageCount: number
}

/** Discovery metadata only. Every match must be resolved against a signed registry before install. */
export async function searchOfficialCatalog(
  query: string,
  type?: PackageType,
  signal?: AbortSignal,
  options: OfficialCatalogApiOptions = {}
): Promise<OfficialCatalogSearchResult> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const abort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (query.length > 1000 || (type !== undefined && !Object.hasOwn(ROUTES, type))) {
      throw new Error('Invalid catalog search')
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error('Invalid catalog timeout')
    }
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('Catalog request timed out', 'TimeoutError'))
    }, timeoutMs)
    const types = type ? [type] : (Object.keys(ROUTES) as PackageType[])
    const results = await Promise.allSettled(
      types.map((itemType) => searchType(query.trim(), itemType, controller.signal, options))
    )
    signal?.throwIfAborted()
    const matches: OfficialCatalogSearchResult['matches'] = []
    let available = true
    let truncated = false
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]
      if (result.status === 'rejected') {
        available = false
      } else {
        matches.push(...result.value.ids.map((id) => ({ type: types[index], id })))
        truncated ||= result.value.truncated
      }
    }
    return {
      matches,
      available,
      ...(!available
        ? { notice: unavailableNotice(timedOut) }
        : truncated
          ? {
              notice:
                'The Phi Website catalog search results were truncated. Use more specific keywords to continue.'
            }
          : {})
    }
  } catch {
    signal?.throwIfAborted()
    return { matches: [], available: false, notice: unavailableNotice(timedOut) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

function unavailableNotice(timedOut: boolean): string {
  return timedOut
    ? 'The Phi Website catalog request timed out. Using the app’s verified catalog.'
    : 'The Phi Website catalog is unavailable. Using the app’s verified catalog.'
}

async function searchType(
  query: string,
  type: PackageType,
  signal: AbortSignal,
  options: OfficialCatalogApiOptions
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids = new Set<string>()
  for (let currentPage = 1; currentPage <= MAX_PAGES; currentPage += 1) {
    signal.throwIfAborted()
    const params = new URLSearchParams({
      q: query,
      page: String(currentPage),
      pageSize: String(PAGE_SIZE)
    })
    const value = await fetchOfficialWebsiteJson(
      `${ROUTES[type]}?${params.toString()}`,
      MAX_PAGE_BYTES,
      { ...options, signal }
    )
    const page = parsePage(value, currentPage)
    for (const item of page.items) {
      if (type === 'mcp' && item.catalogInstallable === false) continue
      const itemIds =
        type === 'wrapper'
          ? wrapperPackageIds(item)
          : type === 'skill'
            ? skillPackageIds(item)
            : [item.id]
      for (const id of itemIds) {
        if (typeof id === 'string' && PACKAGE_ID.test(id)) ids.add(id)
      }
    }
    if (currentPage >= page.pageCount) return { ids: [...ids], truncated: false }
  }
  return { ids: [...ids], truncated: true }
}

export function skillPackageIds(item: Record<string, unknown>): string[] {
  const parts = safeSkillPath(item.id)
  if (!parts) return []
  const id = parts.at(-1)!
  if (!PACKAGE_ID.test(id)) return []
  if (item.path !== undefined) {
    const path = safeSkillPath(item.path)
    if (!path || path[0] !== 'resources' || path[1] !== 'skills') return []
    if (path.at(-1) === 'SKILL.md') path.pop()
    const source = path.slice(2)
    if (source.length === 0 || source.at(-1) !== id) return []
    if (parts.length > 1 && parts.join('/') !== source.join('/')) return []
  }
  return [id]
}

function safeSkillPath(value: unknown): string[] | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    /[\\:%?#]/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return undefined
  }
  const parts = value.split('/')
  if (parts.length > 20 || parts.some((part) => !part || part.startsWith('.'))) return undefined
  return parts
}

function parsePage(value: unknown, expectedPage: number): CatalogPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > PAGE_SIZE ||
    !value.items.every((item) => isRecord(item) && typeof item.id === 'string') ||
    !Number.isSafeInteger(value.total) ||
    (value.total as number) < 0 ||
    value.page !== expectedPage ||
    value.pageSize !== PAGE_SIZE ||
    !Number.isSafeInteger(value.pageCount) ||
    (value.pageCount as number) < 0 ||
    (value.total === 0
      ? (value.pageCount as number) > 1 || value.items.length > 0
      : value.pageCount !== Math.ceil((value.total as number) / PAGE_SIZE))
  ) {
    throw new Error('Invalid official catalog page')
  }
  return { items: value.items as Record<string, unknown>[], pageCount: value.pageCount as number }
}

function wrapperPackageIds(item: Record<string, unknown>): string[] {
  if (typeof item.id !== 'string') return []
  if (PACKAGE_ID.test(item.id)) return [item.id]
  const parts = item.id.split('/')
  const [provider, treeKind, ...names] = parts
  if (
    !Object.hasOwn(WRAPPER_KINDS, treeKind) ||
    names.length === 0 ||
    !parts.every(safeWrapperSegment)
  ) {
    return []
  }
  if (item.path !== undefined) {
    if (typeof item.path !== 'string') return []
    const treeRoot = item.path.match(/^resources\/wrappers\/(.+)\/wrapper$/)?.[1]
    if (!treeRoot || !treeRoot.split('/').every(safeWrapperSegment)) return []
    const expected = `${treeKind}/${provider}/${names.join('/')}`
    const workflowRoot = `${treeKind}/${names.join('/')}`
    if (treeRoot !== expected && !(treeKind === 'workflows' && treeRoot === workflowRoot)) return []
  }
  const kind = WRAPPER_KINDS[treeKind as keyof typeof WRAPPER_KINDS]
  // Signed registries may still contain family packages while the website lists individual adapters.
  return [
    ...new Set([wrapperId(kind, provider, names), wrapperId(kind, provider, names.slice(0, 1))])
  ]
}

function safeWrapperSegment(segment: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(segment)
}

function wrapperId(kind: string, provider: string, names: string[]): string {
  return `${kind}-${provider}-${names.join('-')}`
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
}
