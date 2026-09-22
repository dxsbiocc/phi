import { DB_STANDARD_RECORD_FIELDS } from './adapters/types'
import type { DbDocsSearchResult } from './tool-docs-search'
import type {
  DbConnectorCatalogEntry,
  DbDomainManifest,
  DbFieldSchema,
  DbRecordIdentity
} from './manifest-types'

/**
 * The text the model reads from the discovery tools. Each tool's `details` stays the full
 * record for the UI; this is the same information cut down to what routing and query
 * building need, as single-line JSON.
 */

/** Common fields shown per domain as "why this matched"; enough to route, short enough to skim. */
const MAX_MATCHED_FIELDS = 8

export type DbDomainDetail = 'common' | 'all'

interface SearchContentDomain {
  id: string
  summary: string
  match?: string[]
}

interface SearchContentItem {
  id: string
  name: string
  domains: SearchContentDomain[]
  enabled?: false
}

function matchedFields(commonFields: readonly string[], queryTerms: readonly string[]): string[] {
  if (queryTerms.length === 0) return []
  return commonFields
    .map((field, order) => {
      const lower = field.toLowerCase()
      return { field, order, hits: queryTerms.filter((term) => lower.includes(term)).length }
    })
    .filter(({ hits }) => hits > 0)
    .sort((left, right) => right.hits - left.hits || left.order - right.order)
    .slice(0, MAX_MATCHED_FIELDS)
    .map(({ field }) => field)
}

export function buildDbSearchContent(
  entries: readonly DbConnectorCatalogEntry[],
  queryTerms: readonly string[]
): string {
  const items = entries.map((entry): SearchContentItem => {
    const domains = entry.manifest.domains.map((domain): SearchContentDomain => {
      const match = matchedFields(domain.commonFields, queryTerms)
      return {
        id: domain.id,
        summary: domain.summary,
        ...(match.length > 0 ? { match } : {})
      }
    })
    return {
      id: entry.manifest.id,
      name: entry.manifest.name,
      domains,
      ...(entry.enabledForQuery ? {} : { enabled: false as const })
    }
  })
  return JSON.stringify(items)
}

interface FieldContent {
  name: string
  type?: string
  namespace?: string
  description?: string
  synonyms?: string[]
}

function fieldContent(name: string, schema: DbFieldSchema | undefined): FieldContent {
  if (!schema) return { name }
  return {
    name,
    type: schema.type,
    ...(schema.namespace ? { namespace: schema.namespace } : {}),
    ...(schema.description ? { description: schema.description } : {}),
    ...(schema.synonyms?.length ? { synonyms: schema.synonyms } : {})
  }
}

interface DomainContent {
  database: string
  domain: string
  summary: string
  identity?: DbRecordIdentity
  standardFields: readonly string[]
  commonFields: FieldContent[]
  otherFields?: Array<string | FieldContent>
}

/**
 * The common fields (what a query returns by default) in full; every other declared field by
 * name, or in full with `detail: 'all'`. No declared field is left out.
 */
export function buildDbDomainContent(
  database: string,
  domain: DbDomainManifest,
  detail: DbDomainDetail
): string {
  const schemas = new Map((domain.fields ?? []).map((field) => [field.name, field]))
  const common = new Set(domain.commonFields)
  const otherNames = (domain.fields ?? []).map((field) => field.name).filter((n) => !common.has(n))
  const content: DomainContent = {
    database,
    domain: domain.id,
    summary: domain.summary,
    ...(domain.identity ? { identity: domain.identity } : {}),
    standardFields: DB_STANDARD_RECORD_FIELDS,
    commonFields: domain.commonFields.map((name) => fieldContent(name, schemas.get(name))),
    ...(otherNames.length > 0
      ? {
          otherFields:
            detail === 'all'
              ? otherNames.map((name) => fieldContent(name, schemas.get(name)))
              : otherNames
        }
      : {})
  }
  return JSON.stringify(content)
}

export function parseDbDomainDetail(value: unknown): DbDomainDetail {
  return value === 'all' ? 'all' : 'common'
}

/** Only what identifies a hit and says why it is relevant; ranking internals stay in `details`. */
export function buildDbDocsSearchContent(results: readonly DbDocsSearchResult[]): string {
  return JSON.stringify(
    results.map((hit) => ({
      kind: hit.kind,
      database: hit.database,
      domain: hit.domain,
      field: hit.field,
      title: hit.title,
      snippet: hit.snippet,
      type: hit.type,
      namespace: hit.namespace,
      synonyms: hit.synonyms,
      xref: hit.xref,
      ...(hit.common ? { common: true } : {}),
      ...(hit.enabledForQuery === false ? { enabled: false } : {})
    }))
  )
}
