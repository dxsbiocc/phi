import { DB_STANDARD_RECORD_FIELDS } from './adapters/types'
import { uniprotProteinFilterFields } from './adapters/uniprot-query'
import type { DbDocsSearchResult } from './tool-docs-search'
import type {
  DbConnectorCatalogEntry,
  DbDomainManifest,
  DbFieldSchema,
  DbProtocolFamily,
  DbRecordIdentity
} from './manifest-types'

/**
 * The text the model reads from the discovery tools. Each tool's `details` stays the full
 * record for the UI; this is the same information cut down to what routing and query
 * building need, as single-line JSON.
 */

export type DbDomainDetail = 'common' | 'all'

interface SearchContentItem {
  id: string
  name: string
  enabled?: false
}

export function buildDbSearchContent(entries: readonly DbConnectorCatalogEntry[]): string {
  return JSON.stringify(
    entries.map((entry): SearchContentItem => ({
      id: entry.manifest.id,
      name: entry.manifest.name,
      ...(entry.enabledForQuery ? {} : { enabled: false as const })
    }))
  )
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function templateFilters(template: string): string[] {
  return [...template.matchAll(/\{filter:([^{}]+)\}/g)].map((match) => match[1].trim())
}

export interface DbRouteQueryInput {
  requiredFilters: string[]
  optionalFilters: string[]
  rawQueryAllowed: boolean
  example: Record<string, unknown>
}

/** Derive the model-facing input contract from the same mapping used by the adapter. */
export function dbRouteQueryInput(
  database: string,
  protocolFamily: DbProtocolFamily,
  domain: DbDomainManifest
): DbRouteQueryInput {
  const request = domain.rest?.request
  const templates = request
    ? [
        request.path,
        ...Object.values(request.queryParams ?? {}).filter(
          (value): value is string => typeof value === 'string'
        ),
        ...Object.values(request.jsonBodyTemplates ?? {})
      ]
    : []
  let required = unique([
    ...templates.flatMap(templateFilters),
    ...Object.entries(request?.jsonBodyParamMap ?? {})
      .filter(([bodyKey]) => !request?.jsonBodyOptionalFields?.includes(bodyKey))
      .map(([, field]) => field)
  ])
  let optional = unique([
    ...Object.keys(request?.filterParamMap ?? {}),
    ...Object.entries(request?.jsonBodyParamMap ?? {})
      .filter(([bodyKey]) => request?.jsonBodyOptionalFields?.includes(bodyKey))
      .map(([, field]) => field)
  ]).filter((field) => !required.includes(field))
  if (protocolFamily === 'ontology') {
    required.push(domain.ontology?.operation === 'search' ? 'q' : 'id')
  }
  if (protocolFamily === 'sparql' && domain.sparql?.query) {
    required = unique([...required, ...templateFilters(domain.sparql.query)])
  }
  if (database === 'rest-json/uniprot' && domain.id === 'protein') {
    optional = unique([...optional, ...uniprotProteinFilterFields()])
  }
  if (database === 'rest-json/uniprot' && domain.id === 'id_mapping') {
    required = ['to', 'ids']
    optional = ['from']
  }
  const rawQueryAllowed =
    protocolFamily !== 'rest-json' ||
    (required.length === 0 &&
      (Boolean(request?.rawQueryParam) ||
        templates.some((template) => template.includes('{rawQuery}'))))
  const example: Record<string, unknown> = { database, domain: domain.id }
  if (required.length > 0) {
    example.filters = required.map((field) => ({ field, op: '=', value: `<${field}>` }))
  } else if (rawQueryAllowed) {
    example.rawQuery = '<search term>'
  }
  return { requiredFilters: required, optionalFilters: optional, rawQueryAllowed, example }
}

export function buildDbRoutesContent(
  entry: DbConnectorCatalogEntry,
  intent: string,
  limit: number
): string {
  const terms = intent
    .toLowerCase()
    .split(/[\s,;，；/]+/)
    .filter(Boolean)
  const matches = entry.manifest.domains
    .map((domain, order) => {
      const input = dbRouteQueryInput(entry.manifest.id, entry.manifest.protocolFamily, domain)
      const searchable = [
        domain.id,
        domain.summary,
        ...input.requiredFilters,
        ...input.optionalFilters,
        ...domain.commonFields,
        ...(domain.fields ?? []).flatMap((field) => [
          field.name,
          field.description ?? '',
          ...(field.synonyms ?? [])
        ])
      ]
        .join(' ')
        .toLowerCase()
      return {
        domain,
        input,
        order,
        score: terms.filter((term) => searchable.includes(term)).length
      }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
  return JSON.stringify({
    database: entry.manifest.id,
    intent,
    totalMatches: matches.length,
    routes: matches.slice(0, limit).map(({ domain, input }) => {
      const rankedOptional = input.optionalFilters
        .map((field, order) => ({
          field,
          order,
          score: terms.filter((term) => field.toLowerCase().includes(term)).length
        }))
        .sort((left, right) => right.score - left.score || left.order - right.order)
        .map(({ field }) => field)
      const matchedFields = (domain.fields ?? [])
        .map((field, order) => ({
          name: field.name,
          order,
          score: terms.filter((term) =>
            [field.name, field.description ?? '', ...(field.synonyms ?? [])]
              .join(' ')
              .toLowerCase()
              .includes(term)
          ).length
        }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.order - right.order)
        .slice(0, 5)
        .map(({ name }) => name)
      return {
        domain: domain.id,
        purpose: domain.summary,
        inputFields: unique([...input.requiredFilters, ...rankedOptional]).slice(0, 6),
        ...(matchedFields.length > 0 ? { matchedFields } : {})
      }
    })
  })
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
  queryInput: DbRouteQueryInput
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
  protocolFamily: DbProtocolFamily,
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
    queryInput: dbRouteQueryInput(database, protocolFamily, domain),
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
