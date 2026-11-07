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
import type { WrapperCompositionManifest } from '../../../../../shared/wrapperCompositionManifestTypes'
import type { CatalogBrowseGroup } from '../../../components/catalog/CatalogBrowseLayout'
import type { WrapperFlowGraph } from './wrapperFlow'
import { buildWrapperParamsFlowGraph } from './wrapperFlow'
import type { WrapperCatalogChoice } from './wrapperCatalog'
import { wrapperCopy } from './wrapperCopy'

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
