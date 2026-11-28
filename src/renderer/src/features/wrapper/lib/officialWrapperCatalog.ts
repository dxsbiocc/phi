import type {
  PhiWebsiteCatalogResult,
  PhiWrapperCatalogDetail,
  PhiWrapperCatalogGroup,
  PhiWrapperCatalogTool,
  PhiWrapperGroupsPage,
  PhiWrapperGroupsQuery,
  PhiWrapperToolsPage,
  PhiWrapperToolsQuery
} from '../../../../../shared/phiWebsiteCatalogTypes'
import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import type { WrapperCompositionManifest } from '../../../../../shared/wrapperCompositionManifestTypes'
import type { CatalogBrowseGroup } from '../../../components/catalog/CatalogBrowseLayout'
import type { WrapperFlowGraph } from './wrapperFlow'
import { buildWrapperParamsFlowGraph } from './wrapperFlow'
import { wrapperChoiceIcon, type WrapperCatalogChoice } from './wrapperCatalog'
import { wrapperCopy } from './wrapperCopy'
import { parseWrapperCompositionId } from './wrapperView'

export interface OfficialWrapperCatalogApi {
  listOfficialWrapperGroups?: (
    query: PhiWrapperGroupsQuery
  ) => Promise<PhiWebsiteCatalogResult<PhiWrapperGroupsPage>>
  listOfficialWrapperTools?: (
    query: PhiWrapperToolsQuery
  ) => Promise<PhiWebsiteCatalogResult<PhiWrapperToolsPage>>
  getOfficialWrapperDetail?: (
    id: string
  ) => Promise<PhiWebsiteCatalogResult<PhiWrapperCatalogDetail>>
}

export type OfficialWrapperLoad<T> = { source: 'official'; data: T } | { source: 'fallback' }

/** The website client accepts at most 100 items per page; larger suites read further pages. */
export const OFFICIAL_WRAPPER_SUITE_PAGE_SIZE = 100

async function loadOfficial<T>(
  request: (() => Promise<PhiWebsiteCatalogResult<T>>) | undefined
): Promise<OfficialWrapperLoad<T>> {
  if (!request) return { source: 'fallback' } as const
  try {
    const result = await request()
    return result.status === 'available'
      ? ({ source: 'official', data: result.data } as const)
      : ({ source: 'fallback' } as const)
  } catch {
    return { source: 'fallback' } as const
  }
}

export function loadOfficialWrapperGroups(
  api: OfficialWrapperCatalogApi,
  query: PhiWrapperGroupsQuery
): Promise<OfficialWrapperLoad<PhiWrapperGroupsPage>> {
  return loadOfficial(
    api.listOfficialWrapperGroups ? () => api.listOfficialWrapperGroups!(query) : undefined
  )
}

export function loadOfficialWrapperTools(
  api: OfficialWrapperCatalogApi,
  query: PhiWrapperToolsQuery
): Promise<OfficialWrapperLoad<PhiWrapperToolsPage>> {
  return loadOfficial(
    api.listOfficialWrapperTools ? () => api.listOfficialWrapperTools!(query) : undefined
  )
}

export function loadOfficialWrapperDetail(
  api: OfficialWrapperCatalogApi,
  id: string
): Promise<OfficialWrapperLoad<PhiWrapperCatalogDetail>> {
  return loadOfficial(
    api.getOfficialWrapperDetail ? () => api.getOfficialWrapperDetail!(id) : undefined
  )
}

/** The split view lists every tool in a suite, so follow the service's pages when it has more. */
export async function loadOfficialWrapperSuiteTools(
  api: OfficialWrapperCatalogApi,
  suite: string
): Promise<OfficialWrapperLoad<PhiWrapperCatalogTool[]>> {
  const first = await loadOfficialWrapperTools(
    api,
    officialWrapperToolsQuery(suite, '', 0, OFFICIAL_WRAPPER_SUITE_PAGE_SIZE)
  )
  if (first.source === 'fallback') return first
  const tools = [...first.data.items]
  const pageCount = Math.max(1, first.data.pageCount)
  for (let page = 1; page < pageCount; page += 1) {
    const next = await loadOfficialWrapperTools(
      api,
      officialWrapperToolsQuery(suite, '', page, OFFICIAL_WRAPPER_SUITE_PAGE_SIZE)
    )
    if (next.source === 'fallback') return next
    tools.push(...next.data.items)
  }
  return { source: 'official', data: tools }
}

export function officialWrapperDefaultToolId(
  tools: readonly Pick<PhiWrapperCatalogTool, 'id'>[],
  current?: string
): string | undefined {
  return current && tools.some((tool) => tool.id === current) ? current : tools[0]?.id
}

/** Short list labels drop the redundant suite prefix ("SAMtools sort" → "sort"). */
export function officialWrapperToolShortName(suite: string, name: string): string {
  const prefix = `${suite} `
  return name.toLowerCase().startsWith(prefix.toLowerCase()) && name.length > prefix.length
    ? name.slice(prefix.length)
    : name
}

export function filterOfficialWrapperTools(
  tools: readonly PhiWrapperCatalogTool[],
  query: string
): PhiWrapperCatalogTool[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...tools]
  return tools.filter((tool) =>
    [tool.name, tool.id, tool.summary ?? ''].some((value) => value.toLowerCase().includes(needle))
  )
}

export function officialWrapperGroupsQuery(
  query: string,
  categoryId: string,
  page: number,
  pageSize: number
): PhiWrapperGroupsQuery {
  const normalized = query.trim()
  return {
    ...(normalized ? { q: normalized } : {}),
    ...(categoryId === 'all' ? {} : { category: categoryId }),
    page: page + 1,
    pageSize
  }
}

export function officialWrapperToolsQuery(
  suite: string,
  query: string,
  page: number,
  pageSize: number
): PhiWrapperToolsQuery {
  const normalized = query.trim()
  return {
    group: suite,
    ...(normalized ? { q: normalized } : {}),
    page: page + 1,
    pageSize
  }
}

/** Category ids and labels are service data. Only the synthetic "all" entry is localized here. */
export function officialWrapperCategoryGroups(
  page: Pick<PhiWrapperGroupsPage, 'categories' | 'total'>
): CatalogBrowseGroup[] {
  return [
    { id: 'all', label: wrapperCopy.allWrapperGroups, count: page.total },
    ...page.categories.map((category) => ({
      id: category.id,
      label: category.label,
      count: category.count
    }))
  ]
}

const PACKAGE_KIND_BY_TIER: Readonly<Record<string, string>> = {
  modules: 'module',
  subworkflows: 'subworkflow',
  workflows: 'workflow'
}

/** Website wrapper ids are canonical paths; registry ids use the package-manager convention. */
export function officialWrapperRegistryId(id: string): string {
  const [provider, tier, ...name] = id.split('/')
  const kind = PACKAGE_KIND_BY_TIER[tier ?? '']
  if (!provider || !kind || name.length === 0) return id
  return `${kind}-${provider}-${name.join('-')}`
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
}

export interface OfficialWrapperToolChoice {
  tool: PhiWrapperCatalogTool
  choice: WrapperCatalogChoice
}

/**
 * Browse metadata supplies presentation only. Registry/install state is copied exclusively from
 * the matching PackageRegistryEntryView-backed choice.
 */
export function officialWrapperToolChoices(
  tools: readonly PhiWrapperCatalogTool[],
  registryChoices: readonly WrapperCatalogChoice[]
): OfficialWrapperToolChoice[] {
  const byId = new Map(registryChoices.map((choice) => [choice.id, choice]))
  return tools.map((tool) => {
    const registryId = officialWrapperRegistryId(tool.id)
    const registryChoice = byId.get(registryId)
    return {
      tool,
      choice: {
        ...(registryChoice ?? {
          id: registryId,
          installed: false,
          selected: false,
          enabled: false
        }),
        id: registryId,
        title: tool.name,
        summary: tool.summary ?? '',
        metadata: tool.source,
        category: tool.categoryLabel,
        version: tool.version
      }
    }
  })
}

export function officialWrapperDetailManifest(
  detail: PhiWrapperCatalogDetail
): WrapperCompositionManifest {
  return {
    id: detail.id,
    name: detail.name,
    summary: detail.summary ?? '',
    params: Object.fromEntries(
      detail.inputs.map((param) => [
        param.name,
        {
          kind: param.kind === 'option' ? ('option' as const) : ('input' as const),
          type: param.type ?? param.kind ?? 'value',
          required: param.required ?? false,
          ...(param.description ? { description: param.description } : {})
        }
      ])
    ),
    outputs: Object.fromEntries(
      detail.outputs.map((output) => [
        output.name,
        {
          type: output.type ?? output.kind ?? 'value',
          path: output.name,
          primary: false
        }
      ])
    )
  }
}

export function officialWrapperDetailGraph(detail: PhiWrapperCatalogDetail): WrapperFlowGraph {
  return buildWrapperParamsFlowGraph({
    name: detail.structure.process || detail.name,
    inputLabels: detail.structure.inputs,
    outputLabels: detail.structure.outputs
  })
}

export function officialWrapperGroupRowDetails(group: PhiWrapperCatalogGroup): string {
  return wrapperCopy.toolCount(group.count)
}

const CONVENTIONAL_WRAPPER_PACKAGE_ID = /^(module|subworkflow|workflow)-(nf-core|local)-(.+)$/

function normalizeWrapperPackageSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function parseChoiceIdentity(
  choice: WrapperCatalogChoice
): { kind: string; provider: string; slug: string } | undefined {
  if (choice.cached?.id) {
    const parsed = parseWrapperCompositionId(choice.cached.id)
    const kind = PACKAGE_KIND_BY_TIER[parsed.tier]
    if (kind && parsed.provider && parsed.name) {
      return {
        kind,
        provider: normalizeWrapperPackageSlug(parsed.provider),
        slug: normalizeWrapperPackageSlug(parsed.name)
      }
    }
  }
  const match = CONVENTIONAL_WRAPPER_PACKAGE_ID.exec(choice.id)
  if (!match) return undefined
  return { kind: match[1]!, provider: match[2]!, slug: match[3]! }
}

function syntheticGroupToolChoice(
  group: PhiWrapperCatalogGroup,
  choice: WrapperCatalogChoice
): OfficialWrapperToolChoice {
  return {
    tool: {
      id: choice.cached?.id ?? choice.id,
      name: choice.title,
      summary: choice.summary,
      category: group.category,
      categoryLabel: group.categoryLabel,
      path: '',
      version: choice.version ?? choice.registryEntry?.version ?? '',
      source: choice.metadata,
      suite: group.suite
    },
    choice
  }
}

export interface OfficialWrapperGroupResolution {
  choices?: OfficialWrapperToolChoice[]
  authoritative: boolean
}

function groupAllowedKinds(group: PhiWrapperCatalogGroup): ReadonlySet<string> {
  const categoryKeys = Object.keys(group.categories)
  const tiers = categoryKeys.length > 0 ? categoryKeys : group.category ? [group.category] : []
  return new Set(
    tiers.map((tier) => PACKAGE_KIND_BY_TIER[tier]).filter((kind): kind is string => Boolean(kind))
  )
}

function groupSuiteTarget(suite: string): { provider?: string; slug: string } {
  if (!suite.includes('/')) return { slug: normalizeWrapperPackageSlug(suite) }
  const [rawProvider, ...rawRest] = suite.split('/')
  return {
    provider: normalizeWrapperPackageSlug(rawProvider ?? ''),
    slug: normalizeWrapperPackageSlug(rawRest.join('-'))
  }
}

function matchRegistryChoicesToGroup(
  registryChoices: readonly WrapperCatalogChoice[],
  allowedKinds: ReadonlySet<string>,
  target: { provider?: string; slug: string }
): { exact: WrapperCatalogChoice[]; prefix: WrapperCatalogChoice[] } {
  const exact: WrapperCatalogChoice[] = []
  const prefix: WrapperCatalogChoice[] = []
  for (const choice of registryChoices) {
    const identity = parseChoiceIdentity(choice)
    if (!identity) continue
    if (allowedKinds.size > 0 && !allowedKinds.has(identity.kind)) continue
    if (target.provider && identity.provider !== target.provider) continue
    if (identity.slug === target.slug) {
      exact.push(choice)
      prefix.push(choice)
    } else if (identity.slug.startsWith(`${target.slug}-`)) {
      prefix.push(choice)
    }
  }
  return { exact, prefix }
}

/**
 * Resolves a group row's installable tool choices from cached suite tools when available, or
 * synchronously from the loaded package registry when the slug match is unambiguous.
 */
export function officialWrapperGroupChoices(
  group: PhiWrapperCatalogGroup,
  registryChoices: readonly WrapperCatalogChoice[],
  cachedTools?: readonly PhiWrapperCatalogTool[]
): OfficialWrapperGroupResolution {
  if (cachedTools) {
    return {
      choices: officialWrapperToolChoices(cachedTools, registryChoices),
      authoritative: true
    }
  }
  const target = groupSuiteTarget(group.suite)
  if (registryChoices.length === 0 || group.count <= 0 || !target.slug) {
    return { choices: undefined, authoritative: false }
  }
  const { exact, prefix } = matchRegistryChoicesToGroup(
    registryChoices,
    groupAllowedKinds(group),
    target
  )
  if (group.count === 1 && exact.length === 1) {
    return { choices: [syntheticGroupToolChoice(group, exact[0]!)], authoritative: true }
  }
  if (prefix.length === group.count) {
    return {
      choices: prefix.map((choice) => syntheticGroupToolChoice(group, choice)),
      authoritative: false
    }
  }
  return { choices: undefined, authoritative: false }
}

export function officialWrapperGroupIcon(
  choices: readonly OfficialWrapperToolChoice[] | undefined
): ResourceIconRef | undefined {
  return choices
    ?.map(({ choice }) => wrapperChoiceIcon(choice))
    .find((icon): icon is ResourceIconRef => Boolean(icon))
}
