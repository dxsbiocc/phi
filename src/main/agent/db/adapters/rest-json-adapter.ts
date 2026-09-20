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
import {
  domainSummaryFromManifest,
  normalizeDbRecord,
  projectDbRow,
  validateDbQueryWindow,
  validateDbRequestedFields
} from './types'

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

type RestJsonBodyPrimitive = string | number | boolean
type RestJsonBodyValue = RestJsonBodyPrimitive | RestJsonBodyPrimitive[]

interface BuiltRestJsonRequest {
  path: string
  searchParams: URLSearchParams
  method: 'GET' | 'POST'
  body?: string
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

function primitiveToBodyValue(value: unknown, label: string): RestJsonBodyPrimitive {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  throw new Error(`rest-json body value for ${label} must be string, number, or boolean`)
}

function bodyValueFromFilter(
  filter: DbFilter,
  options: { forceArray: boolean }
): RestJsonBodyValue {
  if (filter.op === 'in') {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value]
    return values.map((value) => primitiveToBodyValue(value, filter.field))
  }
  if (filter.op === '=') {
    const value = primitiveToBodyValue(filter.value, filter.field)
    return options.forceArray ? [value] : value
  }
  throw new Error(`rest-json body filter ${filter.field} only supports = or in`)
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

function restJsonRequestTemplates(domain: DbDomainManifest): string[] {
  const request = domain.rest?.request
  if (!request) return []
  return [
    request.path,
    ...Object.values(request.queryParams ?? {}).filter(
      (value): value is string => typeof value === 'string'
    )
  ]
}

function restJsonTemplateFilterFields(template: string): string[] {
  return [...template.matchAll(/\{filter:([^{}]+)\}/g)]
    .map((match) => match[1]?.trim())
    .filter((field): field is string => Boolean(field))
}

function validateRestJsonQueryInputs(domain: DbDomainManifest, params: DbQueryParams): void {
  validateDbQueryWindow(params, 'opaque')
  const request = domain.rest?.request
  if (!request) throw new Error(`rest-json domain is missing request mapping: ${domain.id}`)
  const filters = params.filters ?? []
  if (filters.length > 0 && params.rawQuery) {
    throw new Error('rest-json filters and rawQuery cannot be used together')
  }

  const seenFields = new Set<string>()
  for (const filter of filters) {
    if (seenFields.has(filter.field)) {
      throw new Error(`rest-json duplicate filter: ${filter.field}`)
    }
    seenFields.add(filter.field)
  }

  const templates = restJsonRequestTemplates(domain)
  const acceptedFields = new Set([
    ...templates.flatMap(restJsonTemplateFilterFields),
    ...Object.keys(request.filterParamMap ?? {}),
    ...Object.values(request.jsonBodyParamMap ?? {})
  ])
  for (const filter of filters) {
    if (!acceptedFields.has(filter.field)) {
      const accepted = [...acceptedFields].sort().join(', ')
      throw new Error(
        `rest-json domain ${domain.id} does not accept filter: ${filter.field}${
          accepted ? `; accepted filters: ${accepted}` : ''
        }`
      )
    }
  }

  const cursorInTemplate = templates.some((template) => /\{cursor\}/.test(template))
  if (params.cursor && !request.cursorParam && !cursorInTemplate) {
    throw new Error(`rest-json domain ${domain.id} does not support cursor pagination`)
  }
}

export function buildRestJsonRequest(
  domain: DbDomainManifest,
  params: DbQueryParams
): BuiltRestJsonRequest {
  const rest = domain.rest
  if (!rest) throw new Error(`rest-json domain is missing request mapping: ${domain.id}`)
  validateRestJsonQueryInputs(domain, params)
  const method = rest.request.method ?? 'GET'

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

  const body: Record<string, RestJsonBodyValue> = {}
  const forceArrayFields = new Set(rest.request.jsonBodyArrayFields ?? [])
  const optionalBodyFields = new Set(rest.request.jsonBodyOptionalFields ?? [])
  for (const [bodyKey, filterField] of Object.entries(rest.request.jsonBodyParamMap ?? {})) {
    const filter = params.filters?.find((candidate) => candidate.field === filterField)
    if (!filter) {
      if (optionalBodyFields.has(bodyKey)) continue
      throw new Error(`rest-json body requires filter: ${filterField}`)
    }
    body[bodyKey] = bodyValueFromFilter(filter, {
      forceArray: forceArrayFields.has(bodyKey)
    })
    consumedFilters.add(filterField)
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
    const queryParam = rest.request.filterParamMap?.[filter.field]
    if (!queryParam) throw new Error(`rest-json filter is not mapped: ${filter.field}`)
    searchParams.append(queryParam, formatFilterValue(filter))
  }

  if (rest.request.limitParam) searchParams.append(rest.request.limitParam, String(params.limit))
  if (rest.request.cursorParam && params.cursor) {
    searchParams.append(rest.request.cursorParam, params.cursor)
  }

  return {
    path: pathTemplate.value,
    searchParams,
    method,
    ...(Object.keys(body).length > 0 ? { body: JSON.stringify(body) } : {})
  }
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
    validateDbRequestedFields(domain, params.fields)
    const rest = domain.rest
    if (!rest) throw new Error(`rest-json domain is missing request mapping: ${params.domain}`)

    const request = buildRestJsonRequest(domain, params)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (request.body !== undefined) headers['content-type'] = 'application/json'
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path: request.path,
      searchParams: request.searchParams,
      method: request.method,
      headers,
      body: request.body,
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: request.method === 'GET' || rest.request.idempotent === true
    })
    const payload = await response.response.json()
    const rows = rowsFromRestJsonPayload(payload, domain, this.manifest.id, params)
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
  domain: DbDomainManifest,
  database: string,
  params: DbQueryParams
): {
  rows: Record<string, unknown>[]
  totalRows?: number
  truncated: boolean
  nextCursor?: string
} {
  const rest = domain.rest as DbRestJsonDomainConfig
  const response = rest.response
  const rawRows = readJsonPath(payload, response?.rowsPath ?? '$')
  const sourceRows = Array.isArray(rawRows) ? rawRows : rawRows === undefined ? [] : [rawRows]
  const mappedRows = sourceRows.map((row) =>
    projectDbRow(normalizeDbRecord(mapRestJsonRow(row, response), database, domain), params.fields)
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
      Boolean(nextCursor) ||
      clientTruncated ||
      isTotalRowsTruncated(totalRows, returnedRows, params.cursor),
    nextCursor
  }
}

function isTotalRowsTruncated(
  totalRows: number | undefined,
  returnedRows: Record<string, unknown>[],
  cursor: string | undefined
): boolean {
  if (totalRows === undefined) return false
  const offset = parseOptionalNumber(cursor)
  if (cursor && offset === undefined) return false
  return (offset ?? 0) + returnedRows.length < totalRows
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
  let values: unknown[] = [payload]
  for (const segment of normalized.split('.')) {
    const next: unknown[] = []
    for (const current of values) {
      if (current === undefined || current === null) continue
      if (segment === '*') {
        if (Array.isArray(current)) next.push(...current)
        else if (isRecord(current)) next.push(...Object.values(current))
        continue
      }
      if (Array.isArray(current)) {
        const index = Number(segment)
        if (Number.isInteger(index) && current[index] !== undefined) next.push(current[index])
        continue
      }
      if (isRecord(current) && current[segment] !== undefined) next.push(current[segment])
    }
    if (next.length === 0) return undefined
    values = next
  }
  return values.length === 1 ? values[0] : values
}
