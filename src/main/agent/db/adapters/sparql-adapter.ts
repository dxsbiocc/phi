import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbDomainManifest,
  DbFieldSchema,
  DbFilter,
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

interface SparqlAdapterOptions {
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  sleep?: DbSleep
  timeoutMs?: number
  now?: () => Date
}

interface SparqlTemplateResult {
  query: string
  consumedFilters: Set<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function primitiveToString(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  throw new Error(`SPARQL value for ${label} must be string, number, or boolean`)
}

function sparqlStringLiteralContent(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

function formatFilterValue(filter: Pick<DbFilter, 'field' | 'op' | 'value'>): string {
  switch (filter.op) {
    case '=':
    case 'like':
      return sparqlStringLiteralContent(primitiveToString(filter.value, filter.field))
    case 'in':
      return Array.isArray(filter.value)
        ? filter.value
            .map((item) => `"${sparqlStringLiteralContent(primitiveToString(item, filter.field))}"`)
            .join(', ')
        : sparqlStringLiteralContent(primitiveToString(filter.value, filter.field))
    default:
      throw new Error(`SPARQL adapter does not support filter op: ${filter.op}`)
  }
}

function renderSparqlTemplate(template: string, params: DbQueryParams): SparqlTemplateResult {
  const consumedFilters = new Set<string>()
  const query = template.replace(/\{(rawQuery|filter:[^{}]+)\}/g, (_match, rawToken: string) => {
    const token = rawToken.trim()
    if (token === 'rawQuery') {
      if (!params.rawQuery) throw new Error('SPARQL template requires rawQuery')
      return sparqlStringLiteralContent(params.rawQuery)
    }
    if (token.startsWith('filter:')) {
      const field = token.slice('filter:'.length).trim()
      if (!field) throw new Error('SPARQL filter template is missing a field name')
      const filter = params.filters?.find((candidate) => candidate.field === field)
      if (!filter) throw new Error(`SPARQL template requires filter: ${field}`)
      consumedFilters.add(field)
      return formatFilterValue(filter)
    }
    throw new Error(`Unsupported SPARQL template token: ${token}`)
  })
  return { query, consumedFilters }
}

export function buildSparqlQuery(domain: DbDomainManifest, params: DbQueryParams): string {
  validateDbQueryWindow(params, 'offset')
  const sparql = domain.sparql
  if (!sparql) throw new Error(`SPARQL domain is missing query mapping: ${domain.id}`)

  const baseQuery = params.rawQuery ?? renderSparqlTemplate(sparql.query, params).query
  return applySparqlWindow(baseQuery, params.limit, params.cursor)
}

export class SparqlAdapter implements DbAdapter {
  constructor(
    private readonly manifest: DbConnectorManifest,
    private readonly options: SparqlAdapterOptions = {}
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
    if (!domain) throw new Error(`Unknown SPARQL domain: ${params.domain}`)
    validateDbRequestedFields(domain, params.fields)
    const query = buildSparqlQuery(domain, params)
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path: '',
      searchParams: new URLSearchParams({ query, format: 'json' }),
      method: 'GET',
      headers: { accept: 'application/sparql-results+json, application/json' },
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    const rows = rowsFromSparqlJson(
      await response.response.json(),
      params,
      domain,
      this.manifest.id
    )
    return {
      rows: rows.rows,
      truncated: rows.truncated,
      nextCursor: rows.nextCursor,
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

function applySparqlWindow(query: string, limit: number, cursor?: string): string {
  const offset = parseCursor(cursor)
  const stripped = query
    .trim()
    .replace(/;+\s*$/g, '')
    .replace(/\s+OFFSET\s+\d+\s*$/i, '')
    .replace(/\s+LIMIT\s+\d+\s*$/i, '')
  return `${stripped}\nLIMIT ${limit}${offset > 0 ? `\nOFFSET ${offset}` : ''}`
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const parsed = Number(cursor)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

function rowsFromSparqlJson(
  payload: unknown,
  params: DbQueryParams,
  domain: DbDomainManifest,
  database: string
): { rows: Record<string, unknown>[]; truncated: boolean; nextCursor?: string } {
  if (
    !isRecord(payload) ||
    !isRecord(payload.results) ||
    !Array.isArray(payload.results.bindings)
  ) {
    throw new Error('Unexpected SPARQL JSON response shape')
  }
  const mappedRows = payload.results.bindings.map((binding) =>
    projectDbRow(normalizeDbRecord(bindingToRow(binding), database, domain), params.fields)
  )
  return {
    rows: mappedRows,
    truncated: mappedRows.length >= params.limit,
    nextCursor:
      mappedRows.length >= params.limit
        ? String(parseCursor(params.cursor) + params.limit)
        : undefined
  }
}

function bindingToRow(binding: unknown): Record<string, unknown> {
  if (!isRecord(binding)) return {}
  return Object.entries(binding).reduce<Record<string, unknown>>((row, [name, value]) => {
    if (!isRecord(value)) return row
    const rawValue = value.value
    if (typeof rawValue !== 'string') return row
    row[name] = coerceSparqlBindingValue(rawValue, value.datatype)
    return row
  }, {})
}

function coerceSparqlBindingValue(value: string, datatype: unknown): unknown {
  if (typeof datatype !== 'string') return value
  if (
    datatype.endsWith('#integer') ||
    datatype.endsWith('#decimal') ||
    datatype.endsWith('#double')
  ) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  if (datatype.endsWith('#boolean')) return value === 'true' || value === '1'
  return value
}
