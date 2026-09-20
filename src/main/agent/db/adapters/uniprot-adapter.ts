import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbDownloadFileCandidate,
  DbFieldSchema,
  DbFilter,
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
  validateDbQueryWindow,
  validateDbRequestedFields
} from './types'

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

interface UniProtIdMappingResults {
  results?: unknown[]
  failedIds?: unknown[]
}

type UniProtRowNormalizer = (entry: unknown) => Record<string, unknown>

const UNIPROT_ACCESSION_PATTERN = /^[A-Z0-9]{6,10}(?:-\d+)?$/i
const DEFAULT_ID_MAPPING_MAX_POLLS = 6
const DEFAULT_ID_MAPPING_POLL_DELAY_MS = 500
const UNIPROT_STRING_FILTER_FIELDS = new Set([
  'accession',
  'primary_accession',
  'entry_name',
  'id',
  'mnemonic',
  'gene_name',
  'gene',
  'gene_symbol',
  'protein_name',
  'protein',
  'product',
  'organism_id',
  'tax_id',
  'taxid',
  'organism',
  'organism_name',
  'species',
  'protein_existence',
  'ec',
  'ec_number',
  'ec_numbers',
  'keyword',
  'keywords',
  'go',
  'go_id',
  'go_terms',
  'xref',
  'cross_reference',
  'xref_database',
  'database'
])
const UNIPROT_RANGE_FILTER_FIELDS = new Set([
  'sequence_length',
  'length',
  'date_created',
  'date_modified',
  'date_sequence_modified'
])
const UNIPROT_STRING_FILTER_OPS = new Set<DbFilter['op']>(['=', 'like', 'in'])
const UNIPROT_RANGE_FILTER_OPS = new Set<DbFilter['op']>(['=', '>', '>=', '<', '<=', 'between'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined
}

function nestedArray(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : []
}

function firstNestedString(value: unknown, keys: string[]): string | undefined {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return stringValue(current)
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]))
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function formatUniProtQueryValue(value: string): string {
  const escaped = escapeQueryValue(value)
  return /\s/.test(value) ? `"${escaped}"` : escaped
}

function primaryFilter(params: DbQueryParams, field: string): DbFilter | undefined {
  return params.filters?.find((filter) => filter.field === field)
}

function filterString(params: DbQueryParams, field: string): string | undefined {
  return stringValue(primaryFilter(params, field)?.value)
}

function filterStringList(params: DbQueryParams, field: string): string[] {
  const value = primaryFilter(params, field)?.value
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((item) => (typeof item === 'string' ? item : undefined)))
  }
  const text = stringValue(value)
  return text
    ? uniqueStrings(
        text
          .split(/[,\s]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      )
    : []
}

function filterBoolean(params: DbQueryParams, field: string): boolean | undefined {
  return booleanValue(primaryFilter(params, field)?.value)
}

function firstFilter(params: DbQueryParams, fields: string[]): DbFilter | undefined {
  return fields.map((field) => primaryFilter(params, field)).find(Boolean)
}

function appendStringQueryFilter(
  queryParts: string[],
  params: DbQueryParams,
  fields: string[],
  queryField: string
): void {
  const filter = firstFilter(params, fields)
  if (!filter) return
  if (!['=', 'like', 'in'].includes(filter.op)) return
  const values = filterValues(filter)
  if (values.length === 0) return
  const formattedValues = values.map((value) => `${queryField}:${formatUniProtQueryValue(value)}`)
  if (formattedValues.length === 1) {
    queryParts.push(formattedValues[0])
    return
  }
  queryParts.push(`(${formattedValues.join(' OR ')})`)
}

function appendRangeQueryFilter(
  queryParts: string[],
  params: DbQueryParams,
  fields: string[],
  queryField: string
): void {
  const filter = firstFilter(params, fields)
  if (!filter) return
  const value = filter.value
  if (filter.op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return
    const [start, end] = value.map(scalarText)
    if (start && end) queryParts.push(`${queryField}:[${start} TO ${end}]`)
    return
  }

  const text = scalarText(value)
  if (!text) return
  switch (filter.op) {
    case '=':
      queryParts.push(`${queryField}:${formatUniProtQueryValue(text)}`)
      break
    case '>':
    case '>=':
      queryParts.push(`${queryField}:[${text} TO *]`)
      break
    case '<':
    case '<=':
      queryParts.push(`${queryField}:[* TO ${text}]`)
      break
    default:
      break
  }
}

function filterValues(filter: DbFilter): string[] {
  if (filter.op === 'in' && Array.isArray(filter.value)) {
    return uniqueStrings(filter.value.map(scalarText))
  }
  const text = scalarText(filter.value)
  return text ? [text] : []
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return stringValue(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

function validateUniProtQueryInputs(params: DbQueryParams): void {
  validateDbQueryWindow(params, 'opaque')
  const filters = params.filters ?? []
  if (filters.length > 0 && params.rawQuery?.trim()) {
    throw new Error('UniProt filters and rawQuery cannot be used together')
  }

  const seenFields = new Set<string>()
  for (const filter of filters) {
    if (seenFields.has(filter.field)) throw new Error(`UniProt duplicate filter: ${filter.field}`)
    seenFields.add(filter.field)
  }

  if (params.domain === 'id_mapping') {
    if (params.rawQuery?.trim()) throw new Error('UniProt ID mapping does not support rawQuery')
    for (const filter of filters) {
      const allowedOps =
        filter.field === 'ids'
          ? UNIPROT_STRING_FILTER_OPS
          : filter.field === 'from' || filter.field === 'to'
            ? new Set<DbFilter['op']>(['='])
            : undefined
      if (!allowedOps) throw new Error(`UniProt id_mapping does not accept filter: ${filter.field}`)
      if (!allowedOps.has(filter.op)) {
        throw new Error(
          `UniProt id_mapping does not support op ${filter.op} for filter: ${filter.field}`
        )
      }
    }
    return
  }

  if (params.domain === 'protein') {
    for (const filter of filters) {
      const allowedOps =
        filter.field === 'reviewed'
          ? new Set<DbFilter['op']>(['='])
          : UNIPROT_STRING_FILTER_FIELDS.has(filter.field)
            ? UNIPROT_STRING_FILTER_OPS
            : UNIPROT_RANGE_FILTER_FIELDS.has(filter.field)
              ? UNIPROT_RANGE_FILTER_OPS
              : undefined
      if (!allowedOps) throw new Error(`UniProt protein does not accept filter: ${filter.field}`)
      if (!allowedOps.has(filter.op)) {
        throw new Error(
          `UniProt protein does not support op ${filter.op} for filter: ${filter.field}`
        )
      }
      if (filter.field === 'reviewed' && typeof filter.value !== 'boolean') {
        throw new Error('UniProt reviewed filter requires a boolean value')
      }
    }
    return
  }

  if (params.domain === 'uniref' || params.domain === 'uniparc' || params.domain === 'proteome') {
    for (const filter of filters) {
      if (!filter.field.trim()) throw new Error(`UniProt ${params.domain} filter field is empty`)
      if (!UNIPROT_STRING_FILTER_OPS.has(filter.op)) {
        throw new Error(
          `UniProt ${params.domain} does not support op ${filter.op} for filter: ${filter.field}`
        )
      }
    }
  }
}

export function directUniProtKbAccession(params: DbQueryParams): string | undefined {
  if (params.domain !== 'protein' || params.rawQuery?.trim() || params.cursor) return undefined
  if (!params.filters || params.filters.length !== 1) return undefined
  const [filter] = params.filters
  if (filter.field !== 'accession' || filter.op !== '=') return undefined
  const accession = stringValue(filter.value)
  if (!accession || !UNIPROT_ACCESSION_PATTERN.test(accession)) return undefined
  return accession.toUpperCase()
}

export function buildUniProtKbSearchParams(params: DbQueryParams): URLSearchParams {
  if (params.domain !== 'protein') throw new Error(`Unknown UniProt domain: ${params.domain}`)
  validateUniProtQueryInputs(params)

  const queryParts: string[] = []
  if (params.rawQuery?.trim()) {
    queryParts.push(params.rawQuery.trim())
  } else {
    const reviewed = filterBoolean(params, 'reviewed')

    appendStringQueryFilter(queryParts, params, ['accession', 'primary_accession'], 'accession')
    appendStringQueryFilter(queryParts, params, ['entry_name', 'id', 'mnemonic'], 'id')
    appendStringQueryFilter(queryParts, params, ['gene_name', 'gene', 'gene_symbol'], 'gene_exact')
    appendStringQueryFilter(
      queryParts,
      params,
      ['protein_name', 'protein', 'product'],
      'protein_name'
    )
    appendStringQueryFilter(queryParts, params, ['organism_id', 'tax_id', 'taxid'], 'organism_id')
    appendStringQueryFilter(
      queryParts,
      params,
      ['organism', 'organism_name', 'species'],
      'organism_name'
    )
    appendStringQueryFilter(queryParts, params, ['protein_existence'], 'existence')
    appendStringQueryFilter(queryParts, params, ['ec', 'ec_number', 'ec_numbers'], 'ec')
    appendStringQueryFilter(queryParts, params, ['keyword', 'keywords'], 'keyword')
    appendStringQueryFilter(queryParts, params, ['go', 'go_id', 'go_terms'], 'go')
    appendStringQueryFilter(queryParts, params, ['xref', 'cross_reference'], 'xref')
    appendStringQueryFilter(queryParts, params, ['xref_database', 'database'], 'database')
    appendRangeQueryFilter(queryParts, params, ['sequence_length', 'length'], 'length')
    appendRangeQueryFilter(queryParts, params, ['date_created'], 'date_created')
    appendRangeQueryFilter(queryParts, params, ['date_modified'], 'date_modified')
    appendRangeQueryFilter(queryParts, params, ['date_sequence_modified'], 'date_sequence_modified')
    if (reviewed !== undefined) queryParts.push(`reviewed:${reviewed ? 'true' : 'false'}`)
  }

  const searchParams = new URLSearchParams()
  searchParams.set('query', queryParts.length > 0 ? queryParts.join(' AND ') : '*')
  searchParams.set(
    'fields',
    [
      'accession',
      'id',
      'reviewed',
      'protein_name',
      'protein_existence',
      'gene_names',
      'organism_name',
      'organism_id',
      'lineage',
      'sequence',
      'date_created',
      'date_modified',
      'date_sequence_modified',
      'version',
      'cc_function',
      'cc_disease',
      'cc_subcellular_location',
      'cc_catalytic_activity',
      'cc_cofactor',
      'cc_pathway',
      'cc_interaction',
      'cc_alternative_products',
      'ec',
      'keyword',
      'lit_pubmed_id',
      'ft_domain',
      'ft_region',
      'ft_act_site',
      'ft_binding',
      'ft_mod_res',
      'ft_variant',
      'ft_signal',
      'ft_transmem',
      'ft_topo_dom',
      'ft_chain',
      'ft_peptide',
      'ft_propep',
      'ft_repeat',
      'ft_motif',
      'ft_coiled',
      'ft_zn_fing',
      'ft_disulfid',
      'ft_mutagen',
      'go_id',
      'xref_pdb',
      'xref_ensembl',
      'xref_refseq',
      'xref_geneid',
      'xref_embl',
      'xref_uniparc',
      'xref_ccds',
      'xref_alphafolddb',
      'xref_interpro',
      'xref_pfam',
      'xref_prosite',
      'xref_smart',
      'xref_supfam',
      'xref_string',
      'xref_reactome',
      'xref_kegg',
      'xref_chembl',
      'xref_drugbank',
      'xref_proteomes'
    ].join(',')
  )
  searchParams.set('format', 'json')
  searchParams.set('size', String(params.limit))
  if (params.cursor) searchParams.set('cursor', params.cursor)
  return searchParams
}

function buildUniProtCollectionSearchParams(params: DbQueryParams): URLSearchParams {
  const searchParams = new URLSearchParams()
  searchParams.set('query', params.rawQuery?.trim() || queryFromFilters(params.filters) || '*')
  searchParams.set('format', 'json')
  searchParams.set('size', String(params.limit))
  if (params.cursor) searchParams.set('cursor', params.cursor)
  return searchParams
}

function queryFromFilters(filters: DbFilter[] | undefined): string | undefined {
  const parts =
    filters
      ?.map((filter) => {
        const values = filterValues(filter)
        if (values.length === 0) return undefined
        const rendered = values.map((value) => `${filter.field}:${formatUniProtQueryValue(value)}`)
        return rendered.length === 1 ? rendered[0] : `(${rendered.join(' OR ')})`
      })
      .filter((part): part is string => Boolean(part)) ?? []
  return parts.length > 0 ? parts.join(' AND ') : undefined
}

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

function uniprotKbRow(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {}
  const accession = stringValue(entry.primaryAccession)
  const sequence = nestedRecord(entry, 'sequence')
  const organism = nestedRecord(entry, 'organism')
  const entryAudit = nestedRecord(entry, 'entryAudit')
  const proteinName = firstNestedString(entry, [
    'proteinDescription',
    'recommendedName',
    'fullName',
    'value'
  ])
  const geneName = firstNestedString(nestedArray(entry, 'genes')[0], ['geneName', 'value'])
  const row: Record<string, unknown> = {
    accession,
    entry_name: stringValue(entry.uniProtkbId),
    reviewed: entry.entryType === 'UniProtKB reviewed (Swiss-Prot)',
    protein_name: proteinName,
    alternative_protein_names: alternativeProteinNames(entry),
    protein_existence: stringValue(entry.proteinExistence),
    gene_name: geneName,
    gene_synonyms: geneValues(entry, 'synonyms'),
    ordered_locus_names: geneValues(entry, 'orderedLocusNames'),
    orf_names: geneValues(entry, 'orfNames'),
    organism: stringValue(organism?.scientificName),
    tax_id: numberValue(organism?.taxonId),
    organism_lineage: stringArray(organism?.lineage),
    sequence: stringValue(sequence?.value),
    sequence_length: numberValue(sequence?.length),
    molecular_weight: numberValue(sequence?.molWeight),
    annotation_score: numberValue(entry.annotationScore),
    secondary_accessions: stringArray(entry.secondaryAccessions),
    date_created: stringValue(entryAudit?.firstPublicDate),
    date_modified: stringValue(entryAudit?.lastAnnotationUpdateDate),
    date_sequence_modified: stringValue(entryAudit?.lastSequenceUpdateDate),
    entry_version: numberValue(entryAudit?.entryVersion),
    sequence_version: numberValue(entryAudit?.sequenceVersion),
    pubmed_ids: pubmedIds(entry),
    references: literatureReferences(entry),
    function: functionComments(entry),
    disease_comments: commentTexts(entry, 'DISEASE'),
    subcellular_locations: subcellularLocations(entry),
    catalytic_activities: catalyticActivities(entry),
    cofactors: cofactors(entry),
    pathways: commentTexts(entry, 'PATHWAY'),
    interactions: interactions(entry),
    isoforms: isoforms(entry, accession),
    isoform_ids: isoformIds(entry),
    ec_numbers: ecNumbers(entry),
    keywords: keywordNames(entry),
    domains: featureAnnotations(entry, ['Domain']),
    regions: featureAnnotations(entry, ['Region']),
    active_sites: featureAnnotations(entry, ['Active site']),
    binding_sites: featureAnnotations(entry, ['Binding site']),
    modified_residues: featureAnnotations(entry, ['Modified residue']),
    variants: featureAnnotations(entry, ['Natural variant']),
    signal_peptides: featureAnnotations(entry, ['Signal peptide']),
    transmembrane_regions: featureAnnotations(entry, ['Transmembrane']),
    topological_domains: featureAnnotations(entry, ['Topological domain']),
    chains: featureAnnotations(entry, ['Chain']),
    peptides: featureAnnotations(entry, ['Peptide']),
    propeptides: featureAnnotations(entry, ['Propeptide']),
    repeats: featureAnnotations(entry, ['Repeat']),
    motifs: featureAnnotations(entry, ['Motif']),
    coiled_coils: featureAnnotations(entry, ['Coiled coil']),
    zinc_fingers: featureAnnotations(entry, ['Zinc finger']),
    disulfide_bonds: featureAnnotations(entry, ['Disulfide bond']),
    mutagenesis_sites: featureAnnotations(entry, ['Mutagenesis']),
    go_terms: crossReferenceIds(entry, 'GO'),
    pdb_ids: crossReferenceIds(entry, 'PDB'),
    ensembl_gene_ids: crossReferenceIds(entry, 'Ensembl'),
    refseq_ids: crossReferenceIds(entry, 'RefSeq'),
    gene_ids: crossReferenceIds(entry, 'GeneID'),
    embl_ids: crossReferenceIds(entry, 'EMBL'),
    uniparc_ids: crossReferenceIds(entry, 'UniParc'),
    ccds_ids: crossReferenceIds(entry, 'CCDS'),
    alphafold_ids: crossReferenceIds(entry, 'AlphaFoldDB'),
    interpro_ids: crossReferenceIds(entry, 'InterPro'),
    pfam_ids: crossReferenceIds(entry, 'Pfam'),
    prosite_ids: crossReferenceIds(entry, 'PROSITE'),
    smart_ids: crossReferenceIds(entry, 'SMART'),
    supfam_ids: crossReferenceIds(entry, 'SUPFAM'),
    string_ids: crossReferenceIds(entry, 'STRING'),
    reactome_ids: crossReferenceIds(entry, 'Reactome'),
    kegg_ids: crossReferenceIds(entry, 'KEGG'),
    chembl_ids: crossReferenceIds(entry, 'ChEMBL'),
    drugbank_ids: crossReferenceIds(entry, 'DrugBank'),
    proteome_ids: crossReferenceIds(entry, 'Proteomes'),
    ...(accession
      ? {
          url: `https://www.uniprot.org/uniprotkb/${accession}/entry`,
          download_urls: uniprotKbDownloadUrls(accession),
          download_files: uniprotKbDownloadFiles(accession)
        }
      : {})
  }
  for (const key of Object.keys(row)) {
    const value = row[key]
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete row[key]
  }
  return row
}

function unirefRow(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {}
  const commonTaxon = nestedRecord(entry, 'commonTaxon')
  const representative = nestedRecord(entry, 'representativeMember')
  const sequence = nestedRecord(representative, 'sequence')
  return compactRecord({
    id: stringValue(entry.id),
    name: stringValue(entry.name),
    entry_type: stringValue(entry.entryType),
    updated: stringValue(entry.updated),
    common_taxon: stringValue(commonTaxon?.scientificName),
    tax_id: numberValue(commonTaxon?.taxonId),
    member_count: numberValue(entry.memberCount),
    organism_count: numberValue(entry.organismCount),
    representative_member_id: stringValue(representative?.memberId),
    representative_member_type: stringValue(representative?.memberIdType),
    representative_protein_name: stringValue(representative?.proteinName),
    representative_organism: stringValue(representative?.organismName),
    representative_tax_id: numberValue(representative?.organismTaxId),
    representative_accessions: stringArray(representative?.accessions),
    uniref90_id: stringValue(representative?.uniref90Id),
    uniref100_id: stringValue(representative?.uniref100Id),
    uniparc_id: stringValue(representative?.uniparcId),
    sequence: stringValue(sequence?.value),
    sequence_length: numberValue(sequence?.length),
    molecular_weight: numberValue(sequence?.molWeight),
    crc64: stringValue(sequence?.crc64),
    md5: stringValue(sequence?.md5),
    seed_id: stringValue(entry.seedId),
    member_id_types: stringArray(entry.memberIdTypes),
    members: stringArray(entry.members),
    organisms: organismRows(nestedArray(entry, 'organisms')),
    go_terms: nestedArray(entry, 'goTerms')
      .map((term) =>
        isRecord(term)
          ? compactRecord({
              go_id: stringValue(term.goId),
              aspect: stringValue(term.aspect)
            })
          : {}
      )
      .filter(nonEmptyRecord),
    url: stringValue(entry.id)
      ? `https://www.uniprot.org/uniref/${encodeURIComponent(String(entry.id))}`
      : undefined
  })
}

function uniparcRow(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {}
  const sequence = nestedRecord(entry, 'sequence')
  return compactRecord({
    uniparc_id: stringValue(entry.uniParcId),
    cross_reference_count: numberValue(entry.crossReferenceCount),
    uniprotkb_accessions: stringArray(entry.uniProtKBAccessions),
    common_taxons: nestedArray(entry, 'commonTaxons')
      .map((taxon) =>
        isRecord(taxon)
          ? compactRecord({
              top_level: stringValue(taxon.topLevel),
              common_taxon: stringValue(taxon.commonTaxon),
              tax_id: numberValue(taxon.commonTaxonId)
            })
          : {}
      )
      .filter(nonEmptyRecord),
    sequence: stringValue(sequence?.value),
    sequence_length: numberValue(sequence?.length),
    molecular_weight: numberValue(sequence?.molWeight),
    crc64: stringValue(sequence?.crc64),
    md5: stringValue(sequence?.md5),
    sequence_features: nestedArray(entry, 'sequenceFeatures')
      .map(sequenceFeatureRow)
      .filter(nonEmptyRecord),
    oldest_cross_ref_created: stringValue(entry.oldestCrossRefCreated),
    most_recent_cross_ref_updated: stringValue(entry.mostRecentCrossRefUpdated),
    url: stringValue(entry.uniParcId)
      ? `https://www.uniprot.org/uniparc/${encodeURIComponent(String(entry.uniParcId))}`
      : undefined
  })
}

function proteomeRow(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {}
  const taxonomy = nestedRecord(entry, 'taxonomy')
  const assembly = nestedRecord(entry, 'genomeAssembly')
  const annotation = nestedRecord(entry, 'genomeAnnotation')
  const statistics = nestedRecord(entry, 'proteomeStatistics')
  return compactRecord({
    id: stringValue(entry.id),
    description: stringValue(entry.description),
    organism: stringValue(taxonomy?.scientificName),
    common_name: stringValue(taxonomy?.commonName),
    tax_id: numberValue(taxonomy?.taxonId),
    mnemonic: stringValue(taxonomy?.mnemonic),
    modified: stringValue(entry.modified),
    proteome_type: stringValue(entry.proteomeType),
    superkingdom: stringValue(entry.superkingdom),
    gene_count: numberValue(entry.geneCount),
    protein_count: numberValue(entry.proteinCount),
    annotation_score: numberValue(entry.annotationScore),
    reviewed_protein_count: numberValue(statistics?.reviewedProteinCount),
    unreviewed_protein_count: numberValue(statistics?.unreviewedProteinCount),
    isoform_protein_count: numberValue(statistics?.isoformProteinCount),
    genome_assembly: compactRecord({
      assembly_id: stringValue(assembly?.assemblyId),
      url: stringValue(assembly?.genomeAssemblyUrl),
      level: stringValue(assembly?.level),
      source: stringValue(assembly?.source)
    }),
    genome_annotation: compactRecord({
      source: stringValue(annotation?.source),
      url: stringValue(annotation?.url)
    }),
    component_count: nestedArray(entry, 'components').length,
    components: nestedArray(entry, 'components').slice(0, 50).map(proteomeComponentRow),
    pubmed_ids: nestedArray(entry, 'citations').flatMap((citation) =>
      isRecord(citation) ? citationCrossReferenceIds(citation, 'PubMed') : []
    ),
    url: stringValue(entry.id)
      ? `https://www.uniprot.org/proteomes/${encodeURIComponent(String(entry.id))}`
      : undefined
  })
}

function organismRows(values: unknown[]): Array<Record<string, unknown>> {
  return values
    .map((organism) =>
      isRecord(organism)
        ? compactRecord({
            scientific_name: stringValue(organism.scientificName),
            common_name: stringValue(organism.commonName),
            tax_id: numberValue(organism.taxonId)
          })
        : {}
    )
    .filter((row) => Object.keys(row).length > 0)
}

function sequenceFeatureRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const interpro = nestedRecord(value, 'interproGroup')
  return compactRecord({
    database: stringValue(value.database),
    database_id: stringValue(value.databaseId),
    interpro_id: stringValue(interpro?.id),
    interpro_name: stringValue(interpro?.name),
    locations: nestedArray(value, 'locations')
      .map((location) =>
        isRecord(location)
          ? compactRecord({
              start: numberValue(location.start),
              end: numberValue(location.end),
              alignment: stringValue(location.alignment)
            })
          : {}
      )
      .filter((location) => Object.keys(location).length > 0)
  })
}

function proteomeComponentRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const annotation = nestedRecord(value, 'genomeAnnotation')
  return compactRecord({
    name: stringValue(value.name),
    protein_count: numberValue(value.proteinCount),
    genome_annotation_source: stringValue(annotation?.source),
    genome_accessions: nestedArray(value, 'proteomeCrossReferences')
      .filter((xref): xref is Record<string, unknown> => isRecord(xref))
      .map((xref) => stringValue(xref.id))
      .filter((id): id is string => Boolean(id))
  })
}

function uniprotKbDownloadUrls(accession: string): Record<string, string> {
  return {
    entry: `https://www.uniprot.org/uniprotkb/${accession}/entry`,
    json: `https://rest.uniprot.org/uniprotkb/${accession}.json`,
    fasta: `https://rest.uniprot.org/uniprotkb/${accession}.fasta`,
    txt: `https://rest.uniprot.org/uniprotkb/${accession}.txt`
  }
}

function uniprotKbDownloadFiles(accession: string): DbDownloadFileCandidate[] {
  const urls = uniprotKbDownloadUrls(accession)
  return [
    {
      kind: 'uniprot_json',
      accession,
      label: 'UniProtKB JSON record',
      url: urls.json,
      format: 'json',
      availability: 'direct_url',
      source: 'derived_from_uniprot_accession'
    },
    {
      kind: 'uniprot_fasta',
      accession,
      label: 'UniProtKB FASTA sequence',
      url: urls.fasta,
      format: 'fasta',
      availability: 'direct_url',
      source: 'derived_from_uniprot_accession'
    },
    {
      kind: 'uniprot_txt',
      accession,
      label: 'UniProtKB flat-file record',
      url: urls.txt,
      format: 'txt',
      availability: 'direct_url',
      source: 'derived_from_uniprot_accession'
    }
  ]
}

function idMappingRows(
  payload: UniProtIdMappingResults,
  context: { jobId: string; fromDb: string; toDb: string }
): Record<string, unknown>[] {
  const rows = Array.isArray(payload.results) ? payload.results : []
  const mapped = rows.filter(isRecord).map((result) => {
    const target = result.to
    const targetId = typeof target === 'string' ? target : firstTargetId(target)
    return compactRecord({
      job_id: context.jobId,
      from_db: context.fromDb,
      to_db: context.toDb,
      from: stringValue(result.from),
      to: targetId,
      target: isRecord(target) ? target : undefined,
      failed: false
    })
  })
  const failed = nestedArray(payload, 'failedIds')
    .map((failedId) =>
      compactRecord({
        job_id: context.jobId,
        from_db: context.fromDb,
        to_db: context.toDb,
        from: typeof failedId === 'string' ? failedId : firstTargetId(failedId),
        failed: true,
        failure: isRecord(failedId) ? failedId : undefined
      })
    )
    .filter((row) => Object.keys(row).length > 0)
  return [...mapped, ...failed]
}

function firstTargetId(target: unknown): string | undefined {
  if (!isRecord(target)) return undefined
  return (
    stringValue(target.primaryAccession) ??
    stringValue(target.uniProtkbId) ??
    stringValue(target.id) ??
    stringValue(target.name)
  )
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.map((item) => (typeof item === 'string' ? item : undefined)))
    : []
}

function functionComments(entry: Record<string, unknown>): string[] {
  return commentTexts(entry, 'FUNCTION')
}

function commentTexts(entry: Record<string, unknown>, commentType: string): string[] {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === commentType
    })
    .flatMap((comment) =>
      nestedArray(comment, 'texts').map((text) => firstNestedString(text, ['value']))
    )
    .filter((value): value is string => Boolean(value))
}

function subcellularLocations(entry: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(entry, 'comments')
      .filter((comment): comment is Record<string, unknown> => {
        return isRecord(comment) && comment.commentType === 'SUBCELLULAR LOCATION'
      })
      .flatMap((comment) => nestedArray(comment, 'subcellularLocations'))
      .map((location) => firstNestedString(location, ['location', 'value']))
  )
}

function pubmedIds(entry: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(entry, 'references').flatMap((reference) => {
      const citation = nestedRecord(reference, 'citation')
      return citation ? citationCrossReferenceIds(citation, 'PubMed') : []
    })
  )
}

function literatureReferences(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return nestedArray(entry, 'references')
    .map((reference) => {
      const citation = nestedRecord(reference, 'citation')
      if (!citation) return {}
      return compactRecord({
        title: stringValue(citation.title),
        citation_type: stringValue(citation.citationType),
        journal: stringValue(citation.journal),
        publication_date: stringValue(citation.publicationDate),
        volume: stringValue(citation.volume),
        first_page: stringValue(citation.firstPage),
        last_page: stringValue(citation.lastPage),
        pubmed_id: citationCrossReferenceIds(citation, 'PubMed')[0],
        doi: citationCrossReferenceIds(citation, 'DOI')[0]
      })
    })
    .filter((reference) => Object.keys(reference).length > 0)
}

function citationCrossReferenceIds(citation: Record<string, unknown>, database: string): string[] {
  return uniqueStrings(
    nestedArray(citation, 'citationCrossReferences')
      .filter((xref): xref is Record<string, unknown> => {
        return (
          isRecord(xref) && stringValue(xref.database)?.toLowerCase() === database.toLowerCase()
        )
      })
      .map((xref) => stringValue(xref.id))
  )
}

function catalyticActivities(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === 'CATALYTIC ACTIVITY'
    })
    .map((comment) => {
      const reaction = nestedRecord(comment, 'reaction')
      return compactRecord({
        reaction: stringValue(reaction?.name),
        ec_number: stringValue(reaction?.ecNumber),
        reaction_cross_references: reactionCrossReferences(reaction),
        notes: nestedArray(comment, 'texts')
          .map((text) => firstNestedString(text, ['value']))
          .filter((value): value is string => Boolean(value))
      })
    })
    .filter((activity) => Object.keys(activity).length > 0)
}

function reactionCrossReferences(
  reaction: Record<string, unknown> | undefined
): Array<Record<string, unknown>> {
  if (!reaction) return []
  return nestedArray(reaction, 'reactionCrossReferences')
    .map((xref) =>
      isRecord(xref)
        ? compactRecord({
            database: stringValue(xref.database),
            id: stringValue(xref.id)
          })
        : {}
    )
    .filter((xref) => Object.keys(xref).length > 0)
}

function cofactors(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === 'COFACTOR'
    })
    .flatMap((comment) => {
      const notes = nestedArray(comment, 'texts')
        .map((text) => firstNestedString(text, ['value']))
        .filter((value): value is string => Boolean(value))
      const rows = nestedArray(comment, 'cofactors')
        .map((cofactor) => {
          const xref = nestedRecord(cofactor, 'cofactorCrossReference')
          return isRecord(cofactor)
            ? compactRecord({
                name: stringValue(cofactor.name),
                database: stringValue(xref?.database),
                id: stringValue(xref?.id),
                notes
              })
            : {}
        })
        .filter((cofactor) => Object.keys(cofactor).length > 0)
      return rows.length > 0 ? rows : notes.map((note) => ({ notes: [note] }))
    })
}

function interactions(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === 'INTERACTION'
    })
    .flatMap((comment) =>
      nestedArray(comment, 'interactions').map((interaction) => {
        if (!isRecord(interaction)) return {}
        return compactRecord({
          interactant_one: interactant(interaction.interactantOne),
          interactant_two: interactant(interaction.interactantTwo),
          experiments: numberValue(interaction.numberOfExperiments)
        })
      })
    )
    .filter((interaction) => Object.keys(interaction).length > 0)
}

function isoforms(
  entry: Record<string, unknown>,
  primaryAccession: string | undefined
): Array<Record<string, unknown>> {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === 'ALTERNATIVE PRODUCTS'
    })
    .flatMap((comment) =>
      nestedArray(comment, 'isoforms').map((isoform) => {
        if (!isRecord(isoform)) return {}
        const ids = isoformIdValues(isoform)
        return compactRecord({
          ids,
          name: firstNestedString(isoform, ['name', 'value']),
          sequence_status: stringValue(isoform.sequenceStatus),
          sequence_ids: isoformSequenceIds(isoform),
          note: isoformNote(isoform),
          urls: isoformUrls(primaryAccession, ids)
        })
      })
    )
    .filter((isoform) => Object.keys(isoform).length > 0)
}

function isoformIds(entry: Record<string, unknown>): string[] {
  return uniqueStrings(isoforms(entry, undefined).flatMap((isoform) => stringArray(isoform.ids)))
}

function isoformIdValues(isoform: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(isoform, 'isoformIds').flatMap((item) => [
      typeof item === 'string' ? item : undefined,
      firstNestedString(item, ['value'])
    ])
  )
}

function isoformSequenceIds(isoform: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(isoform, 'sequenceIds').flatMap((item) => [
      typeof item === 'string' ? item : undefined,
      firstNestedString(item, ['value'])
    ])
  )
}

function isoformNote(isoform: Record<string, unknown>): string | undefined {
  return (
    firstNestedString(isoform, ['note', 'value']) ??
    firstNestedString(nestedArray(isoform, 'synonyms')[0], ['value'])
  )
}

function isoformUrls(
  primaryAccession: string | undefined,
  isoformIds: string[]
): Record<string, string> | undefined {
  if (!primaryAccession || isoformIds.length === 0) return undefined
  return Object.fromEntries(
    isoformIds.map((id) => [id, `https://rest.uniprot.org/uniprotkb/${id}.fasta`])
  )
}

function interactant(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const row = compactRecord({
    accession: stringValue(value.uniProtKBAccession) ?? stringValue(value.accession),
    id: stringValue(value.intActId) ?? stringValue(value.id),
    gene_name: stringValue(value.geneName),
    organism: stringValue(value.organismName)
  })
  return Object.keys(row).length > 0 ? row : undefined
}

function ecNumbers(entry: Record<string, unknown>): string[] {
  const recommended = nestedRecord(nestedRecord(entry, 'proteinDescription'), 'recommendedName')
  const alternatives = nestedArray(nestedRecord(entry, 'proteinDescription'), 'alternativeNames')
  const names = [recommended, ...alternatives].filter(isRecord)
  return uniqueStrings(
    names.flatMap((name) =>
      nestedArray(name, 'ecNumbers').map((ecNumber) => firstNestedString(ecNumber, ['value']))
    )
  )
}

function alternativeProteinNames(entry: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(nestedRecord(entry, 'proteinDescription'), 'alternativeNames').flatMap((name) => [
      firstNestedString(name, ['fullName', 'value']),
      ...nestedArray(name, 'shortNames').map((shortName) => firstNestedString(shortName, ['value']))
    ])
  )
}

function geneValues(entry: Record<string, unknown>, key: string): string[] {
  return uniqueStrings(
    nestedArray(entry, 'genes').flatMap((gene) =>
      nestedArray(gene, key).map((item) => firstNestedString(item, ['value']))
    )
  )
}

function keywordNames(entry: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(entry, 'keywords').map((keyword) => {
      if (typeof keyword === 'string') return keyword
      return firstNestedString(keyword, ['name']) ?? firstNestedString(keyword, ['id'])
    })
  )
}

function featureAnnotations(
  entry: Record<string, unknown>,
  types: string[]
): Array<Record<string, unknown>> {
  const wanted = new Set(types.map((type) => type.toLowerCase()))
  return nestedArray(entry, 'features')
    .filter((feature): feature is Record<string, unknown> => {
      const type = stringValue(isRecord(feature) ? feature.type : undefined)
      return Boolean(type && wanted.has(type.toLowerCase()))
    })
    .map(featureAnnotation)
    .filter((feature) => Object.keys(feature).length > 0)
}

function featureAnnotation(feature: Record<string, unknown>): Record<string, unknown> {
  const location = nestedRecord(feature, 'location')
  return compactRecord({
    type: stringValue(feature.type),
    description: stringValue(feature.description),
    feature_id: stringValue(feature.featureId),
    start: featurePosition(nestedRecord(location, 'start')),
    end: featurePosition(nestedRecord(location, 'end'))
  })
}

function featurePosition(position: Record<string, unknown> | undefined): number | undefined {
  const value = position?.value
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function crossReferenceIds(entry: Record<string, unknown>, database: string): string[] {
  return uniqueStrings(
    nestedArray(entry, 'uniProtKBCrossReferences')
      .filter((xref): xref is Record<string, unknown> => {
        return isRecord(xref) && xref.database === database
      })
      .map((xref) => stringValue(xref.id))
  )
}

function compactRecord(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const value = row[key]
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete row[key]
  }
  return row
}

function nonEmptyRecord(row: Record<string, unknown>): boolean {
  return Object.keys(row).length > 0
}

function parseTotalResults(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isUniProtResultTruncated(
  nextCursor: string | undefined,
  totalRows: number | undefined,
  returnedRows: number,
  cursor: string | undefined
): boolean {
  if (nextCursor) return true
  return !cursor && totalRows !== undefined && returnedRows < totalRows
}

function cursorFromLinkHeader(value: string | null): string | undefined {
  if (!value) return undefined
  const nextLink = value
    .split(',')
    .map((part) => part.trim())
    .find((part) => /rel="next"/.test(part))
  const urlText = nextLink?.match(/<([^>]+)>/)?.[1]
  if (!urlText) return undefined
  try {
    return new URL(urlText).searchParams.get('cursor') ?? undefined
  } catch {
    return undefined
  }
}
