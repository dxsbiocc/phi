import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbDomainManifest,
  DbFieldSchema,
  DbOntologyDomainConfig,
  DbQueryParams
} from '../manifest-types'
import { executeDbHttpRequest, type DbEgressTransport, type DbSleep } from '../policy'
import type { DbAdapter, DbAdapterQueryContext, DomainSummary } from './types'
import {
  domainSummaryFromManifest,
  normalizeDbRecord,
  projectDbRow,
  validateDbQueryWindow,
  validateDbRequestedFields
} from './types'

interface OntologyAdapterOptions {
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  sleep?: DbSleep
  timeoutMs?: number
  now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function filterValue(params: DbQueryParams, field: string): string | undefined {
  const filter = params.filters?.find((candidate) => candidate.field === field)
  if (!filter) return undefined
  if (filter.op !== '=' && filter.op !== 'like') {
    throw new Error(`ontology filter ${field} only supports = or like`)
  }
  if (typeof filter.value === 'string' && filter.value.trim()) return filter.value.trim()
  if (typeof filter.value === 'number' && Number.isFinite(filter.value)) return String(filter.value)
  throw new Error(`ontology filter ${field} must be a string or number`)
}

function requireId(params: DbQueryParams): string {
  const id = filterValue(params, 'id') ?? params.rawQuery?.trim()
  if (!id) throw new Error('ontology lookup requires filter id or rawQuery')
  return id
}

function searchQuery(params: DbQueryParams): string {
  const query = filterValue(params, 'q') ?? params.rawQuery?.trim()
  if (!query) throw new Error('ontology search requires filter q or rawQuery')
  return query
}

export function compactOntologyId(raw: string, idPrefix?: string): string {
  const trimmed = raw.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    const local = trimmed.split(/[/#]/).pop() ?? trimmed
    return local.includes('_') ? local.replace('_', ':') : local
  }
  if (trimmed.includes(':')) return trimmed
  if (idPrefix) return `${idPrefix}:${trimmed}`
  return trimmed
}

export function ontologyIriFromId(rawId: string, ontology: DbOntologyDomainConfig): string {
  const trimmed = rawId.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  const compact = compactOntologyId(trimmed, ontology.idPrefix)
  const suffix = compact.includes(':') ? compact.slice(compact.indexOf(':') + 1) : compact
  const underscored = compact.includes(':')
    ? compact.replace(':', '_')
    : ontology.idPrefix
      ? `${ontology.idPrefix}_${compact}`
      : compact

  if (ontology.iriTemplate) {
    return ontology.iriTemplate
      .replaceAll('{local_id}', underscored)
      .replaceAll('{local}', suffix)
      .replaceAll('{curie}', compact)
  }
  return `http://purl.obolibrary.org/obo/${underscored}`
}

function doubleEncodeIri(iri: string): string {
  return encodeURIComponent(encodeURIComponent(iri))
}

function offsetFromCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const offset = Number(cursor)
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('ontology cursor must be a non-negative integer offset')
  }
  return offset
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (isRecord(item) && typeof item.value === 'string') return item.value
        return undefined
      })
      .filter((item): item is string => Boolean(item?.trim()))
  }
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

export function normalizeOntologyTermRow(
  payload: unknown,
  ontologyId: string
): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {}
  const oboId =
    firstString(record.obo_id, record.oboId, record.curie, record.shortForm, record.short_form) ??
    compactOntologyId(firstString(record.iri, record.id) ?? '')
  const label = firstString(record.label, record.name, record.prefLabel)
  const description = stringList(record.description)
  const annotation = isRecord(record.annotation) ? record.annotation : {}
  const synonyms = [
    ...stringList(record.synonym),
    ...stringList(record.synonyms),
    ...stringList(annotation.hasExactSynonym),
    ...stringList(annotation.has_exact_synonym)
  ]
  return {
    id: oboId || firstString(record.id),
    obo_id: oboId,
    iri: firstString(record.iri, record.id),
    label,
    description: description[0],
    descriptions: description,
    synonyms: Array.from(new Set(synonyms)),
    ontology_id: firstString(record.ontology_name, record.ontologyId, ontologyId),
    is_obsolete: Boolean(record.is_obsolete ?? record.isObsolete),
    parents: stringList(record.parents),
    children: stringList(record.children),
    annotation: record.annotation
  }
}

function rowsFromSearchPayload(
  payload: unknown,
  ontologyId: string
): {
  rows: Record<string, unknown>[]
  totalRows?: number
} {
  const response = isRecord(payload) ? payload.response : undefined
  const docs = isRecord(response) && Array.isArray(response.docs) ? response.docs : []
  const totalRows =
    isRecord(response) && typeof response.numFound === 'number' ? response.numFound : undefined
  return {
    rows: docs.map((doc) => normalizeOntologyTermRow(doc, ontologyId)),
    totalRows
  }
}

function rowsFromEmbeddedList(payload: unknown, ontologyId: string): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.map((item) => normalizeOntologyTermRow(item, ontologyId))
  }
  if (!isRecord(payload)) return []
  const embedded = isRecord(payload._embedded) ? payload._embedded : undefined
  for (const key of ['terms', 'children', 'parents', 'hierarchicalAncestors', 'ancestors']) {
    const value = embedded?.[key]
    if (Array.isArray(value)) {
      return value.map((item) => normalizeOntologyTermRow(item, ontologyId))
    }
  }
  if (payload.iri || payload.label || payload.obo_id) {
    return [normalizeOntologyTermRow(payload, ontologyId)]
  }
  return []
}

function validateOntologyInputs(domain: DbDomainManifest, params: DbQueryParams): void {
  validateDbQueryWindow(params, 'offset')
  if (!domain.ontology) throw new Error(`ontology domain is missing ontology mapping: ${domain.id}`)
  const filters = params.filters ?? []
  if (filters.length > 0 && params.rawQuery) {
    throw new Error('ontology filters and rawQuery cannot be used together')
  }
  const seen = new Set<string>()
  for (const filter of filters) {
    if (seen.has(filter.field)) throw new Error(`ontology duplicate filter: ${filter.field}`)
    seen.add(filter.field)
  }
}

export function buildOntologyRequest(
  domain: DbDomainManifest,
  params: DbQueryParams
): { path: string; searchParams: URLSearchParams } {
  validateOntologyInputs(domain, params)
  const ontology = domain.ontology as DbOntologyDomainConfig
  const searchParams = new URLSearchParams()
  const ontologyId = ontology.ontologyId

  if (ontology.operation === 'search') {
    const query = searchQuery(params)
    const start = offsetFromCursor(params.cursor)
    searchParams.set('q', query)
    searchParams.set('ontology', ontologyId)
    searchParams.set('rows', String(params.limit))
    searchParams.set('start', String(start))
    searchParams.set('queryFields', 'label,synonym,description,short_form,obo_id,iri')
    return { path: '/search', searchParams }
  }

  const id = requireId(params)
  const iri = ontologyIriFromId(id, ontology)
  const encoded = doubleEncodeIri(iri)
  const basePath = `/ontologies/${encodeURIComponent(ontologyId)}/terms/${encoded}`
  if (ontology.operation === 'lookup') return { path: basePath, searchParams }
  if (ontology.operation === 'children') return { path: `${basePath}/children`, searchParams }
  if (ontology.operation === 'parents') return { path: `${basePath}/parents`, searchParams }
  return { path: `${basePath}/hierarchicalAncestors`, searchParams }
}

export class OntologyAdapter implements DbAdapter {
  constructor(
    private readonly manifest: DbConnectorManifest,
    private readonly options: OntologyAdapterOptions = {}
  ) {}

  async listDomains(): Promise<DomainSummary[]> {
    return this.manifest.domains.map(domainSummaryFromManifest)
  }

  async describeDomain(domain: string): Promise<DbFieldSchema[]> {
    return this.manifest.domains.find((candidate) => candidate.id === domain)?.fields ?? []
  }

  async query(
    params: DbQueryParams,
    context: DbAdapterQueryContext = {}
  ): Promise<DbAdapterQueryResult> {
    const domain = this.manifest.domains.find((candidate) => candidate.id === params.domain)
    if (!domain) throw new Error(`Unknown ontology domain: ${params.domain}`)
    validateDbRequestedFields(domain, params.fields)
    const ontology = domain.ontology
    if (!ontology) throw new Error(`ontology domain is missing ontology mapping: ${params.domain}`)

    const request = buildOntologyRequest(domain, params)
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path: request.path,
      searchParams: request.searchParams,
      method: 'GET',
      headers: { accept: 'application/json' },
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    const payload = await response.response.json()
    const parsed =
      ontology.operation === 'search'
        ? rowsFromSearchPayload(payload, ontology.ontologyId)
        : { rows: rowsFromEmbeddedList(payload, ontology.ontologyId), totalRows: undefined }

    const rows = parsed.rows
      .map((row) => projectDbRow(normalizeDbRecord(row, this.manifest.id, domain), params.fields))
      .slice(0, params.limit)
    const start = offsetFromCursor(params.cursor)
    const totalRows = parsed.totalRows
    const nextCursor =
      ontology.operation === 'search' &&
      (totalRows === undefined ? rows.length === params.limit : start + rows.length < totalRows)
        ? String(start + rows.length)
        : undefined

    return {
      rows,
      totalRows,
      truncated: Boolean(nextCursor) || (totalRows !== undefined && totalRows > rows.length),
      ...(nextCursor ? { nextCursor } : {}),
      provenance: {
        database: this.manifest.id,
        domain: params.domain,
        retrievedAt: (this.options.now?.() ?? new Date()).toISOString(),
        rawQueryUsed: Boolean(params.rawQuery),
        attempts: response.attempts,
        retried: response.retried,
        lastStatus: response.lastStatus,
        transportName: response.transportName,
        defaultProxyMode: response.defaultProxyMode
      }
    }
  }
}
