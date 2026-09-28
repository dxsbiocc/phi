import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbDomainManifest,
  DbFieldSchema,
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
import {
  keggListRowsToRecords,
  normalizeKeggCompoundRow,
  normalizeKeggEntryRow,
  normalizeKeggEnzymeRow,
  normalizeKeggGeneRow,
  normalizeKeggPathwayRow,
  parseKeggFlatRecords,
  parseKeggListText
} from './kegg-parser'

interface KeggAdapterOptions {
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  sleep?: DbSleep
  timeoutMs?: number
  now?: () => Date
}

type KeggOperation =
  'find' | 'list' | 'get' | 'link' | 'conv' | 'info' | 'gene' | 'pathway' | 'compound' | 'enzyme'

function filterString(params: DbQueryParams, field: string): string | undefined {
  const filter = params.filters?.find((candidate) => candidate.field === field)
  if (!filter) return undefined
  if (filter.op !== '=' && filter.op !== 'like') {
    throw new Error(`KEGG filter ${field} only supports = or like`)
  }
  if (typeof filter.value === 'string' && filter.value.trim()) return filter.value.trim()
  if (typeof filter.value === 'number' && Number.isFinite(filter.value)) return String(filter.value)
  throw new Error(`KEGG filter ${field} must be a string or number`)
}

function requireFilter(params: DbQueryParams, field: string): string {
  const value = filterString(params, field)
  if (!value) throw new Error(`KEGG domain requires filter: ${field}`)
  return value
}

function operationForDomain(domain: DbDomainManifest): KeggOperation {
  const declared = domain.rest?.request.path
  if (declared?.startsWith('/find/')) return 'find'
  if (declared?.startsWith('/list/')) return 'list'
  if (declared?.startsWith('/link/')) return 'link'
  if (declared?.startsWith('/conv/')) return 'conv'
  if (declared?.startsWith('/info')) return 'info'
  if (declared?.startsWith('/get/')) {
    if (domain.id === 'gene') return 'gene'
    if (domain.id === 'pathway') return 'pathway'
    if (domain.id === 'compound') return 'compound'
    if (domain.id === 'enzyme') return 'enzyme'
    return 'get'
  }
  switch (domain.id) {
    case 'find':
    case 'find_genes':
    case 'find_pathway':
    case 'find_compound':
      return 'find'
    case 'list':
    case 'list_pathways':
      return 'list'
    case 'link':
      return 'link'
    case 'conv':
      return 'conv'
    case 'info':
      return 'info'
    case 'gene':
      return 'gene'
    case 'pathway':
      return 'pathway'
    case 'compound':
      return 'compound'
    case 'enzyme':
      return 'enzyme'
    default:
      return 'get'
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ':')
}

export function buildKeggRequestPath(domain: DbDomainManifest, params: DbQueryParams): string {
  validateDbQueryWindow(params, 'opaque')
  const operation = operationForDomain(domain)

  if (operation === 'info') {
    const database = filterString(params, 'database') ?? 'kegg'
    return `/info/${encodePathSegment(database)}`
  }

  if (operation === 'find') {
    const database =
      filterString(params, 'database') ??
      (domain.id === 'find_pathway'
        ? 'pathway'
        : domain.id === 'find_compound'
          ? 'compound'
          : domain.id === 'find_genes'
            ? 'genes'
            : undefined)
    const query = filterString(params, 'query') ?? params.rawQuery?.trim()
    if (!database) throw new Error('KEGG find requires filter database')
    if (!query) throw new Error('KEGG find requires filter query or rawQuery')
    return `/find/${encodePathSegment(database)}/${encodePathSegment(query)}`
  }

  if (operation === 'list') {
    const database =
      filterString(params, 'database') ?? (domain.id === 'list_pathways' ? 'pathway' : undefined)
    if (!database) throw new Error('KEGG list requires filter database')
    const organism = filterString(params, 'organism')
    return organism
      ? `/list/${encodePathSegment(database)}/${encodePathSegment(organism)}`
      : `/list/${encodePathSegment(database)}`
  }

  if (operation === 'link') {
    const target = requireFilter(params, 'target')
    const source = requireFilter(params, 'source')
    return `/link/${encodePathSegment(target)}/${encodePathSegment(source)}`
  }

  if (operation === 'conv') {
    const target = requireFilter(params, 'target')
    const source = requireFilter(params, 'source')
    return `/conv/${encodePathSegment(target)}/${encodePathSegment(source)}`
  }

  const entry =
    filterString(params, 'entry') ?? filterString(params, 'id') ?? params.rawQuery?.trim()
  if (!entry) throw new Error('KEGG get requires filter entry/id or rawQuery')
  return `/get/${encodePathSegment(entry)}`
}

function normalizeRowsForDomain(domain: DbDomainManifest, text: string): Record<string, unknown>[] {
  const operation = operationForDomain(domain)
  if (
    operation === 'find' ||
    operation === 'list' ||
    operation === 'link' ||
    operation === 'conv'
  ) {
    return keggListRowsToRecords(parseKeggListText(text))
  }
  if (operation === 'info') {
    return [{ info: text.trim(), text: text.trim() }]
  }

  const records = parseKeggFlatRecords(text)
  return records.map((record) => {
    switch (operation) {
      case 'gene':
        return normalizeKeggGeneRow(record)
      case 'pathway':
        return normalizeKeggPathwayRow(record)
      case 'compound':
        return normalizeKeggCompoundRow(record)
      case 'enzyme':
        return normalizeKeggEnzymeRow(record)
      default:
        return normalizeKeggEntryRow(record)
    }
  })
}

function validateKeggInputs(domain: DbDomainManifest, params: DbQueryParams): void {
  validateDbQueryWindow(params, 'opaque')
  const filters = params.filters ?? []
  if (filters.length > 0 && params.rawQuery) {
    throw new Error('KEGG filters and rawQuery cannot be used together')
  }
  const seen = new Set<string>()
  for (const filter of filters) {
    if (seen.has(filter.field)) throw new Error(`KEGG duplicate filter: ${filter.field}`)
    seen.add(filter.field)
  }
  // Force path construction validation.
  buildKeggRequestPath(domain, params)
}

export class KeggAdapter implements DbAdapter {
  constructor(
    private readonly manifest: DbConnectorManifest,
    private readonly options: KeggAdapterOptions = {}
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
    if (!domain) throw new Error(`Unknown KEGG domain: ${params.domain}`)
    validateDbRequestedFields(domain, params.fields, ['raw_fields', 'text', 'info'])
    validateKeggInputs(domain, params)

    const path = buildKeggRequestPath(domain, params)
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path,
      method: 'GET',
      headers: { accept: 'text/plain' },
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    const text = await response.response.text()
    const mapped = normalizeRowsForDomain(domain, text).map((row) =>
      projectDbRow(normalizeDbRecord(row, this.manifest.id, domain), params.fields)
    )
    const offset = params.cursor ? Number(params.cursor) : 0
    if (
      params.cursor &&
      (!/^\d+$/.test(params.cursor) || !Number.isSafeInteger(offset) || offset < 0)
    ) {
      throw new Error('KEGG cursor must be a non-negative integer offset')
    }
    const sliced = mapped.slice(offset, offset + params.limit)
    const nextCursor =
      offset + sliced.length < mapped.length ? String(offset + sliced.length) : undefined

    return {
      rows: sliced,
      totalRows: mapped.length,
      truncated: Boolean(nextCursor),
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
