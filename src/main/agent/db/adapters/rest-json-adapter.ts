import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbDomainManifest,
  DbFieldSchema,
  DbFilter,
  DbQueryParams,
  DbRestJsonDomainConfig
} from '../manifest-types'
import { executeDbHttpRequest, type DbEgressTransport, type DbSleep } from '../policy'
import type { DbAdapter, DbAdapterQueryContext, DomainSummary } from './types'
import { domainSummaryFromManifest } from './types'

interface RestJsonAdapterOptions {
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  sleep?: DbSleep
  timeoutMs?: number
  now?: () => Date
}

interface RestJsonTemplateResult {
  value: string
  consumedFilters: Set<string>
  consumedRawQuery: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function formatFilterValue(filter: Pick<DbFilter, 'field' | 'op' | 'value'>): string {
  switch (filter.op) {
    case '=':
    case 'like':
      return primitiveToString(filter.value, filter.field)
    case 'in':
      return Array.isArray(filter.value)
        ? filter.value.map((item) => primitiveToString(item, filter.field)).join(',')
        : primitiveToString(filter.value, filter.field)
    case 'between':
      if (!Array.isArray(filter.value) || filter.value.length < 2) {
        throw new Error(`rest-json filter ${filter.field} between requires two values`)
      }
      return `${primitiveToString(filter.value[0], filter.field)},${primitiveToString(
        filter.value[1],
        filter.field
      )}`
    default:
      throw new Error(`rest-json adapter does not support filter op: ${filter.op}`)
  }
}

function primitiveToString(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  throw new Error(`rest-json value for ${label} must be string, number, or boolean`)
}

function renderRestJsonTemplate(
  template: string,
  params: DbQueryParams,
  options: { encodePathSegment: boolean }
): RestJsonTemplateResult {
  const consumedFilters = new Set<string>()
  let consumedRawQuery = false
  const value = template.replace(/\{([^{}]+)\}/g, (_match, rawToken: string) => {
    const token = rawToken.trim()
    let replacement: string
    if (token === 'rawQuery') {
      if (!params.rawQuery) throw new Error('rest-json template requires rawQuery')
      consumedRawQuery = true
      replacement = params.rawQuery
    } else if (token === 'limit') {
      replacement = String(params.limit)
    } else if (token === 'cursor') {
      if (!params.cursor) throw new Error('rest-json template requires cursor')
      replacement = params.cursor
    } else if (token.startsWith('filter:')) {
      const field = token.slice('filter:'.length).trim()
      if (!field) throw new Error('rest-json filter template is missing a field name')
      const filter = params.filters?.find((candidate) => candidate.field === field)
      if (!filter) throw new Error(`rest-json template requires filter: ${field}`)
      consumedFilters.add(field)
      replacement = formatFilterValue(filter)
    } else {
      throw new Error(`Unsupported rest-json template token: ${token}`)
    }
    return options.encodePathSegment ? encodeURIComponent(replacement) : replacement
  })
  return { value, consumedFilters, consumedRawQuery }
}

export function buildRestJsonRequest(
  domain: DbDomainManifest,
  params: DbQueryParams
): { path: string; searchParams: URLSearchParams } {
  const rest = domain.rest
  if (!rest) throw new Error(`rest-json domain is missing request mapping: ${domain.id}`)

  const pathTemplate = renderRestJsonTemplate(rest.request.path, params, {
    encodePathSegment: true
  })
  const consumedFilters = new Set(pathTemplate.consumedFilters)
  let consumedRawQuery = pathTemplate.consumedRawQuery
  const searchParams = new URLSearchParams()

  for (const [key, value] of Object.entries(rest.request.queryParams ?? {})) {
    const rendered =
      typeof value === 'string'
        ? renderRestJsonTemplate(value, params, { encodePathSegment: false })
        : undefined
    if (rendered) {
      for (const field of rendered.consumedFilters) consumedFilters.add(field)
      consumedRawQuery = consumedRawQuery || rendered.consumedRawQuery
      searchParams.append(key, rendered.value)
    } else {
      searchParams.append(key, String(value))
    }
  }

  if (params.rawQuery) {
    if (rest.request.rawQueryParam) {
      searchParams.append(rest.request.rawQueryParam, params.rawQuery)
      consumedRawQuery = true
    }
    if (!consumedRawQuery) throw new Error('rest-json rawQuery requires rawQueryParam or template')
  }

  for (const filter of params.filters ?? []) {
    if (consumedFilters.has(filter.field)) continue
    const queryParam = rest.request.filterParamMap?.[filter.field] ?? filter.field
    searchParams.append(queryParam, formatFilterValue(filter))
  }

  if (rest.request.limitParam) searchParams.append(rest.request.limitParam, String(params.limit))
  if (rest.request.cursorParam && params.cursor) {
    searchParams.append(rest.request.cursorParam, params.cursor)
  }

  return { path: pathTemplate.value, searchParams }
}

export class RestJsonAdapter implements DbAdapter {
  constructor(
    private readonly manifest: DbConnectorManifest,
    private readonly options: RestJsonAdapterOptions = {}
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
    if (!domain) throw new Error(`Unknown rest-json domain: ${params.domain}`)
    const rest = domain.rest
    if (!rest) throw new Error(`rest-json domain is missing request mapping: ${params.domain}`)
    if (rest.request.method && rest.request.method !== 'GET') {
      throw new Error(`Unsupported rest-json method: ${rest.request.method}`)
    }

    const request = buildRestJsonRequest(domain, params)
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path: request.path,
      searchParams: request.searchParams,
      method: 'GET',
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    const payload = await response.response.json()
    const rows = rowsFromRestJsonPayload(payload, rest, params)
    return {
      rows: rows.rows,
      totalRows: rows.totalRows,
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

function rowsFromRestJsonPayload(
  payload: unknown,
  rest: DbRestJsonDomainConfig,
  params: DbQueryParams
): {
  rows: Record<string, unknown>[]
  totalRows?: number
  truncated: boolean
  nextCursor?: string
} {
  const response = rest.response
  const rawRows = readJsonPath(payload, response?.rowsPath ?? '$')
  const sourceRows = Array.isArray(rawRows) ? rawRows : rawRows === undefined ? [] : [rawRows]
  const mappedRows = sourceRows.map((row) =>
    projectRestJsonRow(mapRestJsonRow(row, response), params)
  )
  const returnedRows = mappedRows.slice(0, params.limit)
  const totalRows = parseOptionalNumber(
    response?.totalRowsPath ? readJsonPath(payload, response.totalRowsPath) : undefined
  )
  let nextCursor = stringifyOptionalValue(
    response?.nextCursorPath ? readJsonPath(payload, response.nextCursorPath) : undefined
  )
  const clientTruncated = mappedRows.length > params.limit
  if (!nextCursor && clientTruncated && rest.request.cursorParam) {
    nextCursor = String((parseOptionalNumber(params.cursor) ?? 0) + params.limit)
  }
  return {
    rows: returnedRows,
    totalRows,
    truncated:
      Boolean(nextCursor) || clientTruncated || isTotalRowsTruncated(totalRows, returnedRows),
    nextCursor
  }
}

function isTotalRowsTruncated(
  totalRows: number | undefined,
  returnedRows: Record<string, unknown>[]
): boolean {
  return totalRows !== undefined && returnedRows.length < totalRows
}

function mapRestJsonRow(
  row: unknown,
  response: DbRestJsonDomainConfig['response']
): Record<string, unknown> {
  const fieldMap = response?.fieldMap
  if (fieldMap) {
    return Object.entries(fieldMap).reduce<Record<string, unknown>>((next, [field, path]) => {
      const value = readJsonPath(row, path)
      if (value !== undefined) next[field] = value
      return next
    }, {})
  }
  return isRecord(row) ? { ...row } : { value: row }
}

function projectRestJsonRow(
  row: Record<string, unknown>,
  params: DbQueryParams
): Record<string, unknown> {
  if (!params.fields || params.fields.length === 0) return row
  return params.fields.reduce<Record<string, unknown>>((next, field) => {
    if (row[field] !== undefined) next[field] = row[field]
    return next
  }, {})
}

function stringifyOptionalValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

function readJsonPath(payload: unknown, path: string): unknown {
  if (!path || path === '$') return payload
  const normalized = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1')
  if (!normalized) return payload
  return normalized.split('.').reduce<unknown>((current, segment) => {
    if (current === undefined || current === null) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      return Number.isInteger(index) ? current[index] : undefined
    }
    if (isRecord(current)) return current[segment]
    return undefined
  }, payload)
}
