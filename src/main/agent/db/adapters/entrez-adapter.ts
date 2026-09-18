import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbFieldSchema,
  DbFilter,
  DbQueryParams
} from '../manifest-types'
import { executeDbHttpRequest, type DbEgressTransport, type DbSleep } from '../policy'
import type { DbAdapter, DbAdapterQueryContext, DomainSummary } from './types'
import { domainSummaryFromManifest } from './types'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valueToTerm(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueToTerm).join(' OR ')
  if (value === undefined || value === null) return ''
  return String(value)
}

export function entrezTermFromFilters(filters: DbFilter[] = []): string {
  return filters
    .map((filter) => {
      const value = valueToTerm(filter.value)
      switch (filter.op) {
        case '=':
          return `${value}[${filter.field}]`
        case 'like':
          return `${value}[${filter.field}]`
        case 'in':
          return Array.isArray(filter.value)
            ? filter.value.map((item) => `${valueToTerm(item)}[${filter.field}]`).join(' OR ')
            : `${value}[${filter.field}]`
        case 'between':
          return Array.isArray(filter.value) && filter.value.length >= 2
            ? `${valueToTerm(filter.value[0])}:${valueToTerm(filter.value[1])}[${filter.field}]`
            : ''
        default:
          throw new Error(`Entrez adapter does not support filter op: ${filter.op}`)
      }
    })
    .filter(Boolean)
    .join(' AND ')
}

export function buildEntrezSearchParams(
  manifest: DbConnectorManifest,
  params: DbQueryParams
): URLSearchParams {
  const domain = manifest.domains.find((candidate) => candidate.id === params.domain)
  if (!domain?.dbParam) throw new Error(`Unknown Entrez domain: ${params.domain}`)
  const query = params.rawQuery ?? entrezTermFromFilters(params.filters)
  if (!query) throw new Error('Entrez query requires filters or rawQuery')

  return new URLSearchParams({
    db: domain.dbParam,
    term: query,
    retmode: 'json',
    retmax: String(params.limit),
    ...(params.cursor ? { retstart: params.cursor } : {})
  })
}

export function buildEntrezSummaryParams(
  manifest: DbConnectorManifest,
  params: Pick<DbQueryParams, 'domain'>,
  ids: string[]
): URLSearchParams {
  const domain = manifest.domains.find((candidate) => candidate.id === params.domain)
  if (!domain?.dbParam) throw new Error(`Unknown Entrez domain: ${params.domain}`)
  return new URLSearchParams({
    db: domain.dbParam,
    id: ids.join(','),
    retmode: 'json'
  })
}

export function buildEntrezFetchParams(
  manifest: DbConnectorManifest,
  params: Pick<DbQueryParams, 'domain'>,
  ids: string[]
): URLSearchParams {
  const domain = manifest.domains.find((candidate) => candidate.id === params.domain)
  if (!domain?.dbParam) throw new Error(`Unknown Entrez domain: ${params.domain}`)
  return new URLSearchParams({
    db: domain.dbParam,
    id: ids.join(','),
    retmode: 'xml'
  })
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
      params.domain === 'pubmed' && searchResult.ids.length > 0
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
    const rowsWithFetch =
      fetchResponse && params.domain === 'pubmed'
        ? addPubmedAbstracts(rows, await fetchResponse.response.text())
        : rows
    const provenance = combineEntrezQueryResponses(response, summaryResponse, fetchResponse)
    return {
      rows: rowsWithFetch,
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

function normalizeEntrezSummaryRow(
  uid: string,
  summary: Record<string, unknown>,
  domain: string
): Record<string, unknown> {
  const row: Record<string, unknown> = { uid }
  if (domain === 'gene') addGeneSummaryFields(row, summary)
  if (domain === 'pubmed') addPubmedSummaryFields(row, summary)
  if (domain === 'clinvar') addClinvarSummaryFields(row, summary)

  for (const [key, value] of Object.entries(summary)) {
    if (key === 'uid' || key === 'error') continue
    if (row[key] === undefined) row[key] = value
  }
  return row
}

function addGeneSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const symbol = firstString(summary.name, summary.nomenclaturesymbol)
  if (symbol) row.symbol = symbol
  const description = firstString(summary.description, summary.summary)
  if (description) row.description = description
  const chromosome = firstString(summary.chromosome)
  if (chromosome) row.chromosome = chromosome
  const aliases = aliasesFrom(summary.otheraliases)
  if (aliases.length > 0) row.aliases = aliases
  const mapLocation = firstString(summary.maplocation)
  if (mapLocation) row.mapLocation = mapLocation
  if (isRecord(summary.organism)) {
    row.organism = {
      scientificName: summary.organism.scientificname,
      commonName: summary.organism.commonname,
      taxId: summary.organism.taxid
    }
  }
}

function addPubmedSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const title = firstString(summary.title)
  if (title) row.title = title
  const pubdate = firstString(summary.pubdate, summary.epubdate)
  if (pubdate) row.pubdate = pubdate
  const journal = firstString(summary.fulljournalname, summary.source)
  if (journal) row.journal = journal
  const authors = authorNames(summary.authors)
  if (authors.length > 0) row.authors = authors
  const doi = articleId(summary.articleids, 'doi')
  if (doi) row.doi = doi
}

function addClinvarSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const title = firstString(summary.title)
  if (title) row.title = title
  const accession = firstString(summary.accession)
  if (accession) row.accession = accession
  const variationId = firstString(summary.variation_id, summary.variationid, summary.uid)
  if (variationId) row.variation_id = variationId
  const clinicalSignificance = firstString(
    summary.clinical_significance,
    summary.clinicalsignificance,
    isRecord(summary.clinical_significance) ? summary.clinical_significance.description : undefined
  )
  if (clinicalSignificance) row.clinical_significance = clinicalSignificance
  const gene = firstString(summary.gene, summary.genesymbol)
  if (gene) row.gene = gene
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function aliasesFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  }
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function authorNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (isRecord(item)) return firstString(item.name)
      return undefined
    })
    .filter((item): item is string => item !== undefined)
}

function articleId(value: unknown, idType: string): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    if (!isRecord(item)) continue
    if (firstString(item.idtype)?.toLowerCase() === idType) return firstString(item.value, item.id)
  }
  return undefined
}

function addPubmedAbstracts(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const abstracts = parsePubmedAbstractsXml(xml)
  return rows.map((row) => {
    const abstract = typeof row.uid === 'string' ? abstracts.get(row.uid) : undefined
    return abstract ? { ...row, abstract } : row
  })
}

function parsePubmedAbstractsXml(xml: string): Map<string, string> {
  const abstracts = new Map<string, string>()
  for (const articleMatch of xml.matchAll(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/g)) {
    const article = articleMatch[0]
    const pmid = article.match(/<PMID\b[^>]*>([\s\S]*?)<\/PMID>/)?.[1]?.trim()
    if (!pmid) continue
    const parts = [...article.matchAll(/<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
      .map((match) => {
        const label = match[1].match(/\bLabel="([^"]+)"/)?.[1]
        const text = normalizeXmlText(match[2])
        if (!text) return undefined
        return label ? `${decodeXmlEntities(label)}: ${text}` : text
      })
      .filter((item): item is string => item !== undefined)
    if (parts.length > 0) abstracts.set(pmid, parts.join('\n'))
  }
  return abstracts
}

function normalizeXmlText(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
