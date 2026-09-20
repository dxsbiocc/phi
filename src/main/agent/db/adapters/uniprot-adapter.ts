import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbFieldSchema,
  DbQueryParams
} from '../manifest-types'
import {
  executeDbHttpRequest,
  type DbEgressTransport,
  type DbHttpResponse,
  type DbSleep
} from '../policy'
import type { DbAdapter, DbAdapterQueryContext, DomainSummary } from './types'
import {
  domainSummaryFromManifest,
  normalizeDbRecord,
  projectDbRow,
  validateDbRequestedFields
} from './types'
import {
  buildUniProtCollectionSearchParams,
  buildUniProtKbSearchParams,
  directUniProtKbAccession,
  filterString,
  filterStringList,
  validateUniProtQueryInputs
} from './uniprot-query'
import {
  idMappingRows,
  proteomeRow,
  uniparcRow,
  uniprotKbRow,
  unirefRow,
  type UniProtIdMappingResults
} from './uniprot-rows'
import {
  cursorFromLinkHeader,
  isUniProtResultTruncated,
  parseTotalResults,
  stringValue
} from './uniprot-utils'

export { buildUniProtKbSearchParams, directUniProtKbAccession } from './uniprot-query'

interface UniProtAdapterOptions {
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  sleep?: DbSleep
  timeoutMs?: number
  now?: () => Date
}

interface UniProtJsonResult {
  results?: unknown[]
}

interface UniProtIdMappingRunResult {
  jobId?: string
}

interface UniProtIdMappingStatusResult {
  jobStatus?: string
}

type UniProtRowNormalizer = (entry: unknown) => Record<string, unknown>

const DEFAULT_ID_MAPPING_MAX_POLLS = 6
const DEFAULT_ID_MAPPING_POLL_DELAY_MS = 500
export class UniProtAdapter implements DbAdapter {
  constructor(
    private readonly manifest: DbConnectorManifest,
    private readonly options: UniProtAdapterOptions = {}
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
    validateUniProtQueryInputs(params)
    const domain = this.manifest.domains.find((candidate) => candidate.id === params.domain)
    if (!domain) throw new Error(`Unknown UniProt domain: ${params.domain}`)
    validateDbRequestedFields(
      domain,
      params.fields,
      params.domain === 'protein' ? ['entry_fasta', 'txt'] : []
    )
    if (params.domain === 'id_mapping') return this.queryIdMapping(params, context)
    if (params.domain === 'uniref') {
      return this.queryJsonCollection('/uniref/search', params, context, unirefRow)
    }
    if (params.domain === 'uniparc') {
      return this.queryJsonCollection('/uniparc/search', params, context, uniparcRow)
    }
    if (params.domain === 'proteome') {
      return this.queryJsonCollection('/proteomes/search', params, context, proteomeRow)
    }
    if (params.domain !== 'protein') throw new Error(`Unknown UniProt domain: ${params.domain}`)
    const directAccession = directUniProtKbAccession(params)
    if (directAccession) return this.queryEntryByAccession(directAccession, params, context)

    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path: '/uniprotkb/search',
      searchParams: buildUniProtKbSearchParams(params),
      method: 'GET',
      headers: { accept: 'application/json' },
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    const payload = (await response.response.json()) as UniProtJsonResult
    const results = Array.isArray(payload.results) ? payload.results : []
    const rows = results.map(uniprotKbRow).map((row) => this.projectRow(row, params))
    const nextCursor = cursorFromLinkHeader(response.response.headers.get('link'))
    const totalRows = parseTotalResults(response.response.headers.get('x-total-results'))
    return {
      rows,
      totalRows,
      truncated: isUniProtResultTruncated(nextCursor, totalRows, rows.length, params.cursor),
      ...(nextCursor ? { nextCursor } : {}),
      provenance: {
        database: this.manifest.id,
        domain: params.domain,
        retrievedAt: (this.options.now?.() ?? new Date()).toISOString(),
        sourceVersion: response.response.headers.get('x-uniprot-release') ?? undefined,
        rawQueryUsed: Boolean(params.rawQuery),
        attempts: response.attempts,
        retried: response.retried,
        lastStatus: response.lastStatus,
        transportName: response.transportName,
        defaultProxyMode: response.defaultProxyMode
      }
    }
  }

  private async queryJsonCollection(
    path: string,
    params: DbQueryParams,
    context: DbAdapterQueryContext,
    normalizeRow: UniProtRowNormalizer
  ): Promise<DbAdapterQueryResult> {
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path,
      searchParams: buildUniProtCollectionSearchParams(params),
      method: 'GET',
      headers: { accept: 'application/json' },
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    const payload = (await response.response.json()) as UniProtJsonResult
    const results = Array.isArray(payload.results) ? payload.results : []
    const rows = results.map(normalizeRow).map((row) => this.projectRow(row, params))
    const nextCursor = cursorFromLinkHeader(response.response.headers.get('link'))
    const totalRows = parseTotalResults(response.response.headers.get('x-total-results'))
    return {
      rows,
      totalRows,
      truncated: isUniProtResultTruncated(nextCursor, totalRows, rows.length, params.cursor),
      ...(nextCursor ? { nextCursor } : {}),
      provenance: {
        database: this.manifest.id,
        domain: params.domain,
        retrievedAt: (this.options.now?.() ?? new Date()).toISOString(),
        sourceVersion: response.response.headers.get('x-uniprot-release') ?? undefined,
        rawQueryUsed: Boolean(params.rawQuery),
        attempts: response.attempts,
        retried: response.retried,
        lastStatus: response.lastStatus,
        transportName: response.transportName,
        defaultProxyMode: response.defaultProxyMode
      }
    }
  }

  private async queryIdMapping(
    params: DbQueryParams,
    context: DbAdapterQueryContext
  ): Promise<DbAdapterQueryResult> {
    const fromDb = filterString(params, 'from') ?? 'UniProtKB_AC-ID'
    const toDb = filterString(params, 'to')
    const ids = filterStringList(params, 'ids')
    if (!toDb) throw new Error('UniProt ID mapping requires a to filter.')
    if (ids.length === 0) throw new Error('UniProt ID mapping requires one or more ids.')

    const body = new URLSearchParams({
      from: fromDb,
      to: toDb,
      ids: ids.join(',')
    })
    const run = await executeDbHttpRequest({
      manifest: this.manifest,
      path: '/idmapping/run',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: body.toString(),
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: false
    })
    const runPayload = (await run.response.json()) as UniProtIdMappingRunResult
    const jobId = stringValue(runPayload.jobId)
    if (!jobId) throw new Error('UniProt ID mapping response did not include a jobId.')

    const status = await this.waitForIdMappingJob(jobId, context)
    const result = await executeDbHttpRequest({
      manifest: this.manifest,
      path: `/idmapping/results/${encodeURIComponent(jobId)}`,
      searchParams: {
        format: 'json',
        size: params.limit,
        ...(params.cursor ? { cursor: params.cursor } : {})
      },
      method: 'GET',
      headers: { accept: 'application/json' },
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    const payload = (await result.response.json()) as UniProtIdMappingResults
    const rows = idMappingRows(payload, {
      jobId,
      fromDb,
      toDb
    }).map((row) => this.projectRow(row, params))
    const nextCursor = cursorFromLinkHeader(result.response.headers.get('link'))
    const totalRows = parseTotalResults(result.response.headers.get('x-total-results'))
    return {
      rows,
      totalRows,
      truncated: isUniProtResultTruncated(nextCursor, totalRows, rows.length, params.cursor),
      ...(nextCursor ? { nextCursor } : {}),
      provenance: {
        database: this.manifest.id,
        domain: params.domain,
        retrievedAt: (this.options.now?.() ?? new Date()).toISOString(),
        sourceVersion:
          result.response.headers.get('x-uniprot-release') ??
          status.response.headers.get('x-uniprot-release') ??
          undefined,
        rawQueryUsed: false,
        attempts: run.attempts + status.attempts + result.attempts,
        retried: run.retried || status.retried || result.retried,
        lastStatus: result.lastStatus,
        transportName: result.transportName,
        defaultProxyMode: result.defaultProxyMode
      }
    }
  }

  private async waitForIdMappingJob(
    jobId: string,
    context: DbAdapterQueryContext
  ): Promise<DbHttpResponse> {
    const maxPolls = DEFAULT_ID_MAPPING_MAX_POLLS
    let attempts = 0
    let retried = false
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const response = await executeDbHttpRequest({
        manifest: this.manifest,
        path: `/idmapping/status/${encodeURIComponent(jobId)}`,
        method: 'GET',
        headers: { accept: 'application/json' },
        defaultProxyMode: context.defaultProxyMode,
        transport: this.options.transport,
        proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
        sleep: this.options.sleep,
        timeoutMs: this.options.timeoutMs,
        cacheTtlMs: 0,
        idempotent: true
      })
      attempts += response.attempts
      retried = retried || response.retried
      const payload = (await response.response.clone().json()) as UniProtIdMappingStatusResult
      const status = stringValue(payload.jobStatus)?.toUpperCase()
      if (!status || status === 'FINISHED') return { ...response, attempts, retried }
      if (status === 'FAILED') throw new Error(`UniProt ID mapping job failed: ${jobId}`)
      await (
        this.options.sleep ??
        ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
      )(DEFAULT_ID_MAPPING_POLL_DELAY_MS)
    }
    throw new Error(`UniProt ID mapping job did not finish after ${maxPolls} status checks.`)
  }

  private async queryEntryByAccession(
    accession: string,
    params: DbQueryParams,
    context: DbAdapterQueryContext
  ): Promise<DbAdapterQueryResult> {
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path: `/uniprotkb/${encodeURIComponent(accession)}.json`,
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
    const textResponses = await this.queryEntryTextResources(accession, params, context)
    const row = this.projectRow({ ...uniprotKbRow(payload), ...textResponses.fields }, params)
    const rows = Object.keys(row).length > 0 ? [row] : []
    const responses = [response, ...textResponses.responses]
    const lastResponse = responses[responses.length - 1] ?? response
    return {
      rows,
      totalRows: rows.length,
      truncated: false,
      provenance: {
        database: this.manifest.id,
        domain: params.domain,
        retrievedAt: (this.options.now?.() ?? new Date()).toISOString(),
        sourceVersion:
          textResponses.sourceVersion ??
          response.response.headers.get('x-uniprot-release') ??
          undefined,
        rawQueryUsed: false,
        attempts: responses.reduce((total, item) => total + item.attempts, 0),
        retried: responses.some((item) => item.retried),
        lastStatus: lastResponse.lastStatus,
        transportName: lastResponse.transportName,
        defaultProxyMode: lastResponse.defaultProxyMode
      }
    }
  }

  private async queryEntryTextResources(
    accession: string,
    params: DbQueryParams,
    context: DbAdapterQueryContext
  ): Promise<{
    fields: Record<string, unknown>
    responses: DbHttpResponse[]
    sourceVersion?: string
  }> {
    const fields = new Set(params.fields ?? [])
    const shouldFetchFasta = fields.has('fasta') || fields.has('entry_fasta')
    const shouldFetchFlatFile = fields.has('flat_file') || fields.has('txt')
    if (!shouldFetchFasta && !shouldFetchFlatFile) {
      return { fields: {}, responses: [] }
    }

    const output: Record<string, unknown> = {}
    const responses: DbHttpResponse[] = []
    let sourceVersion: string | undefined
    if (shouldFetchFasta) {
      const fasta = await this.queryEntryTextResource(accession, 'fasta', context)
      responses.push(fasta.response)
      sourceVersion = fasta.sourceVersion ?? sourceVersion
      output.fasta = fasta.text
      output.entry_fasta = fasta.text
    }
    if (shouldFetchFlatFile) {
      const flatFile = await this.queryEntryTextResource(accession, 'txt', context)
      responses.push(flatFile.response)
      sourceVersion = flatFile.sourceVersion ?? sourceVersion
      output.flat_file = flatFile.text
      output.txt = flatFile.text
    }
    return { fields: output, responses, sourceVersion }
  }

  private projectRow(row: Record<string, unknown>, params: DbQueryParams): Record<string, unknown> {
    const domain = this.manifest.domains.find((candidate) => candidate.id === params.domain)
    if (!domain) throw new Error(`Unknown UniProt domain: ${params.domain}`)
    return projectDbRow(normalizeDbRecord(row, this.manifest.id, domain), params.fields)
  }

  private async queryEntryTextResource(
    accession: string,
    format: 'fasta' | 'txt',
    context: DbAdapterQueryContext
  ): Promise<{ text: string; response: DbHttpResponse; sourceVersion?: string }> {
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path: `/uniprotkb/${encodeURIComponent(accession)}.${format}`,
      method: 'GET',
      headers: { accept: format === 'fasta' ? 'text/x-fasta,text/plain' : 'text/plain' },
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    return {
      text: await response.response.text(),
      response,
      sourceVersion: response.response.headers.get('x-uniprot-release') ?? undefined
    }
  }
}
