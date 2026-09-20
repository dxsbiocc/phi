import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbFieldSchema,
  DbQueryParams
} from '../manifest-types'
import { executeDbHttpRequest, type DbEgressTransport, type DbSleep } from '../policy'
import { addBioSampleFetchDetails } from './entrez-biosample'
import { addBioProjectFetchDetails } from './entrez-bioproject'
import { addClinvarFetchDetails } from './entrez-clinvar'
import { addGeneFetchDetails } from './entrez-gene'
import {
  buildEntrezFetchParams,
  buildEntrezSearchParams,
  buildEntrezSummaryParams,
  isEntrezFastaDomain
} from './entrez-params'
import { addFastaSequences } from './entrez-fasta'
import { addGeoFetchDetails } from './entrez-geo'
import { addPubmedFetchDetails } from './entrez-pubmed'
import { addSraFetchDetails } from './entrez-sra'
import { normalizeEntrezSummaryRow } from './entrez-summary'
import { addTaxonomyFetchDetails } from './entrez-taxonomy'
import { isRecord, parseOptionalNumber } from './entrez-utils'
import type { DbAdapter, DbAdapterQueryContext, DomainSummary } from './types'
import {
  domainSummaryFromManifest,
  normalizeDbRecord,
  projectDbRow,
  validateDbRequestedFields
} from './types'

export {
  buildEntrezFetchParams,
  buildEntrezSearchParams,
  buildEntrezSummaryParams,
  entrezTermFromFilters
} from './entrez-params'

interface EntrezAdapterOptions {
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  sleep?: DbSleep
  timeoutMs?: number
  now?: () => Date
}

interface EntrezSearchResult {
  ids: string[]
  totalRows?: number
  nextCursor?: string
}

interface EntrezQueryResponse {
  attempts: number
  retried: boolean
  lastStatus: number
  transportName: string
  defaultProxyMode: NonNullable<DbAdapterQueryContext['defaultProxyMode']>
}

export class EntrezAdapter implements DbAdapter {
  constructor(
    private readonly manifest: DbConnectorManifest,
    private readonly options: EntrezAdapterOptions = {}
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
    if (!domain?.dbParam) throw new Error(`Unknown Entrez domain: ${params.domain}`)
    validateDbRequestedFields(domain, params.fields)
    const searchParams = buildEntrezSearchParams(this.manifest, params)
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path: 'esearch.fcgi',
      searchParams,
      method: 'GET',
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    const searchResult = parseEntrezSearchResponse(await response.response.json(), params)
    const summaryResponse =
      searchResult.ids.length === 0
        ? undefined
        : await executeDbHttpRequest({
            manifest: this.manifest,
            path: 'esummary.fcgi',
            searchParams: buildEntrezSummaryParams(this.manifest, params, searchResult.ids),
            method: 'GET',
            defaultProxyMode: context.defaultProxyMode,
            transport: this.options.transport,
            proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
            sleep: this.options.sleep,
            timeoutMs: this.options.timeoutMs,
            idempotent: true
          })
    const rows = summaryResponse
      ? parseEntrezSummaryResponse(
          await summaryResponse.response.json(),
          searchResult.ids,
          params.domain
        )
      : []
    const fetchResponse =
      shouldFetchEntrezDomain(params.domain) && searchResult.ids.length > 0
        ? await executeDbHttpRequest({
            manifest: this.manifest,
            path: 'efetch.fcgi',
            searchParams: buildEntrezFetchParams(this.manifest, params, searchResult.ids),
            method: 'GET',
            defaultProxyMode: context.defaultProxyMode,
            transport: this.options.transport,
            proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
            sleep: this.options.sleep,
            timeoutMs: this.options.timeoutMs,
            idempotent: true
          })
        : undefined
    const rowsWithFetch = fetchResponse
      ? addEntrezFetchFields(params.domain, rows, await fetchResponse.response.text())
      : rows
    const projectedRows = rowsWithFetch.map((row) =>
      projectDbRow(normalizeDbRecord(row, this.manifest.id, domain), params.fields)
    )
    const provenance = combineEntrezQueryResponses(response, summaryResponse, fetchResponse)
    return {
      rows: projectedRows,
      totalRows: searchResult.totalRows,
      truncated: Boolean(searchResult.nextCursor),
      nextCursor: searchResult.nextCursor,
      provenance: {
        database: this.manifest.id,
        domain: params.domain,
        retrievedAt: (this.options.now?.() ?? new Date()).toISOString(),
        rawQueryUsed: Boolean(params.rawQuery),
        attempts: provenance.attempts,
        retried: provenance.retried,
        lastStatus: provenance.lastStatus,
        transportName: provenance.transportName,
        defaultProxyMode: provenance.defaultProxyMode
      }
    }
  }
}

function parseEntrezSearchResponse(payload: unknown, params: DbQueryParams): EntrezSearchResult {
  if (!isRecord(payload) || !isRecord(payload.esearchresult)) {
    throw new Error('Unexpected Entrez esearch response shape')
  }
  const result = payload.esearchresult
  const ids = Array.isArray(result.idlist)
    ? result.idlist.filter((item): item is string => typeof item === 'string')
    : []
  const totalRows = parseOptionalNumber(result.count)
  const start = parseOptionalNumber(params.cursor) ?? 0
  const nextStart = start + ids.length
  const nextCursor =
    totalRows !== undefined && ids.length > 0 && nextStart < totalRows
      ? String(nextStart)
      : undefined

  return {
    ids,
    totalRows,
    nextCursor
  }
}

function parseEntrezSummaryResponse(
  payload: unknown,
  ids: string[],
  domain: string
): Record<string, unknown>[] {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    throw new Error('Unexpected Entrez esummary response shape')
  }
  const result = payload.result
  return ids.map((uid) => {
    const summary = result[uid]
    return normalizeEntrezSummaryRow(uid, isRecord(summary) ? summary : {}, domain)
  })
}

function combineEntrezQueryResponses(
  first: EntrezQueryResponse,
  ...rest: Array<EntrezQueryResponse | undefined>
): EntrezQueryResponse {
  const responses = [first, ...rest].filter(
    (response): response is EntrezQueryResponse => response !== undefined
  )
  const last = responses[responses.length - 1]
  return {
    attempts: responses.reduce((total, response) => total + response.attempts, 0),
    retried: responses.some((response) => response.retried),
    lastStatus: last.lastStatus,
    transportName: last.transportName,
    defaultProxyMode: last.defaultProxyMode
  }
}

function shouldFetchEntrezDomain(domain: string): boolean {
  return (
    domain === 'gene' ||
    domain === 'pubmed' ||
    domain === 'biosample' ||
    domain === 'sra' ||
    domain === 'geo' ||
    domain === 'bioproject' ||
    domain === 'taxonomy' ||
    domain === 'clinvar' ||
    isEntrezFastaDomain(domain)
  )
}

function addEntrezFetchFields(
  domain: string,
  rows: Record<string, unknown>[],
  payload: string
): Record<string, unknown>[] {
  if (domain === 'gene') return addGeneFetchDetails(rows, payload)
  if (domain === 'pubmed') return addPubmedFetchDetails(rows, payload)
  if (domain === 'biosample') return addBioSampleFetchDetails(rows, payload)
  if (domain === 'sra') return addSraFetchDetails(rows, payload)
  if (domain === 'geo') return addGeoFetchDetails(rows, payload)
  if (domain === 'bioproject') return addBioProjectFetchDetails(rows, payload)
  if (domain === 'taxonomy') return addTaxonomyFetchDetails(rows, payload)
  if (domain === 'clinvar') return addClinvarFetchDetails(rows, payload)
  if (isEntrezFastaDomain(domain)) return addFastaSequences(rows, payload)
  return rows
}
