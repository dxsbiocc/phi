import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { readAppSettings } from '../app-settings'
import { getPhiAgentDir } from '../runtime-paths'
import { EntrezAdapter } from './adapters/entrez-adapter'
import { RestJsonAdapter } from './adapters/rest-json-adapter'
import { SparqlAdapter } from './adapters/sparql-adapter'
import { UniProtAdapter } from './adapters/uniprot-adapter'
import { getDbProxyTransport } from './egress-transport'
import { findDbConnectorCatalogEntry, listDbConnectorCatalog } from './catalog'
import { buildDbQueryToolDetails } from './result-writer'
import { DbHttpError, type DbEgressTransport, type DbSleep } from './policy'
import { DB_STANDARD_RECORD_FIELDS } from './adapters/types'
import type { DbAdapter, DbAdapterQueryContext } from './adapters/types'
import type {
  DbAdapterQueryResult,
  DbConnectorCatalogEntry,
  DbDomainManifest,
  DbFieldSchema,
  DbFilter,
  DbQueryParams,
  DbQueryToolErrorCode,
  DbQueryToolErrorDetails,
  DbResolvedQuery,
  DbXrefRule
} from './manifest-types'

export interface DefaultDbAdapterOptions {
  entrez?: {
    transport?: DbEgressTransport
    proxyTransport?: DbEgressTransport
    sleep?: DbSleep
    timeoutMs?: number
    now?: () => Date
  }
  restJson?: {
    transport?: DbEgressTransport
    proxyTransport?: DbEgressTransport
    sleep?: DbSleep
    timeoutMs?: number
    now?: () => Date
  }
  sparql?: {
    transport?: DbEgressTransport
    proxyTransport?: DbEgressTransport
    sleep?: DbSleep
    timeoutMs?: number
    now?: () => Date
  }
}

type DbDocsSearchKind = 'database' | 'domain' | 'field' | 'xref'

const DB_TOOL_ROUTING_HINT =
  'For biological database lookup requests such as NCBI Entrez, PubMed, ClinVar, Ensembl, UniProt, genes, variants, proteins, nucleotide sequences, FASTA records, accessions, and field/schema lookup, infer the database/domain from the user intent and use the db_* tools automatically. Prefer db_* over general web search for structured database records; the user should not need to name tool functions.'

const MAX_DB_QUERY_PAGES = 10

interface DbDocsSearchResult {
  kind: DbDocsSearchKind
  database: string
  domain?: string
  field?: string
  title: string
  snippet: string
  score: number
  matchReasons: string[]
  protocolFamily?: string
  curationTier?: string
  trustTier?: string
  enabledForQuery?: boolean
  type?: string
  namespace?: string
  synonyms?: string[]
  nullable?: boolean
  common?: boolean
  xref?: {
    from: DbXrefRule['from']
    to: DbXrefRule['to']
  }
}

async function queryDbAdapterPages(
  adapter: DbAdapter,
  params: DbQueryParams,
  context: DbAdapterQueryContext,
  maxPages: number
): Promise<DbAdapterQueryResult> {
  const pages: DbAdapterQueryResult[] = []
  const seenCursors = new Set<string>()
  let cursor = params.cursor
  if (cursor) seenCursors.add(cursor)

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await adapter.query({ ...params, cursor }, context)
    pages.push(page)
    if (!page.truncated || !page.nextCursor || pageIndex + 1 >= maxPages) break
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`database adapter returned repeated pagination cursor: ${page.nextCursor}`)
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  if (pages.length === 1) return pages[0]
  const first = pages[0]
  const last = pages[pages.length - 1]
  const attempts = pages
    .map((page) => page.provenance.attempts)
    .filter((value): value is number => typeof value === 'number')
  return {
    rows: pages.flatMap((page) => page.rows),
    totalRows: pages.find((page) => page.totalRows !== undefined)?.totalRows,
    truncated: last.truncated,
    ...(last.nextCursor ? { nextCursor: last.nextCursor } : {}),
    provenance: {
      ...last.provenance,
      sourceVersion: last.provenance.sourceVersion ?? first.provenance.sourceVersion,
      rawQueryUsed: pages.some((page) => page.provenance.rawQueryUsed),
      ...(attempts.length > 0
        ? { attempts: attempts.reduce((total, value) => total + value, 0) }
        : {}),
      retried: pages.some((page) => page.provenance.retried),
      pagesFetched: pages.length
    }
  }
}

interface DbDocsSearchCandidate {
  result: Omit<DbDocsSearchResult, 'score' | 'matchReasons'>
  searchFields: Array<{ label: string; value: string; weight: number }>
}

interface ResolvedDbQueryInput {
  database: string
  domain: string
  filters?: DbFilter[]
  fields?: string[]
  rawQuery?: string
  resolvedQuery: DbResolvedQuery
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numericParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function querySourceParam(
  record: Record<string, unknown>
): { source: 'query' | 'term' | 'keyword'; value: string } | undefined {
  const query = stringParam(record.query)
  if (query) return { source: 'query', value: query }
  const term = stringParam(record.term)
  if (term) return { source: 'term', value: term }
  const keyword = stringParam(record.keyword)
  return keyword ? { source: 'keyword', value: keyword } : undefined
}

function fieldsParam(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((field): field is string => typeof field === 'string' && field.trim() !== '')
    : undefined
}

function filtersParam(value: unknown): DbFilter[] | undefined {
  return Array.isArray(value) ? (value as DbFilter[]) : undefined
}

function catalogSearchItem(entry: DbConnectorCatalogEntry): Record<string, unknown> {
  return {
    id: entry.manifest.id,
    name: entry.manifest.name,
    protocolFamily: entry.manifest.protocolFamily,
    trustTier: entry.trustTier,
    curationTier: entry.manifest.curationTier,
    enabledForQuery: entry.enabledForQuery,
    domains: entry.manifest.domains.map((domain) => ({
      id: domain.id,
      summary: domain.summary,
      commonFields: domain.commonFields
    }))
  }
}

function docsSearchCandidates(entry: DbConnectorCatalogEntry): DbDocsSearchCandidate[] {
  return [
    databaseDocsCandidate(entry),
    ...entry.manifest.domains.flatMap((domain) => [
      domainDocsCandidate(entry, domain),
      ...fieldDocsCandidates(entry, domain)
    ]),
    ...(entry.manifest.xref ?? []).map((xref) => xrefDocsCandidate(entry, xref))
  ]
}

function databaseDocsCandidate(entry: DbConnectorCatalogEntry): DbDocsSearchCandidate {
  const domainIds = entry.manifest.domains.map((domain) => domain.id)
  const title = `${entry.manifest.name} (${entry.manifest.id})`
  const snippet = `Domains: ${domainIds.join(', ')}. Protocol: ${entry.manifest.protocolFamily}.`
  return {
    result: {
      kind: 'database',
      database: entry.manifest.id,
      title,
      snippet,
      protocolFamily: entry.manifest.protocolFamily,
      curationTier: entry.manifest.curationTier,
      trustTier: entry.trustTier,
      enabledForQuery: entry.enabledForQuery
    },
    searchFields: [
      { label: 'database', value: entry.manifest.id, weight: 80 },
      { label: 'name', value: entry.manifest.name, weight: 60 },
      { label: 'protocol', value: entry.manifest.protocolFamily, weight: 25 },
      { label: 'domains', value: domainIds.join(' '), weight: 20 },
      {
        label: 'domain_summaries',
        value: entry.manifest.domains.map((domain) => domain.summary).join(' '),
        weight: 8
      }
    ]
  }
}

function domainDocsCandidate(
  entry: DbConnectorCatalogEntry,
  domain: DbDomainManifest
): DbDocsSearchCandidate {
  return {
    result: {
      kind: 'domain',
      database: entry.manifest.id,
      domain: domain.id,
      title: `${entry.manifest.id}/${domain.id}`,
      snippet: domain.summary,
      protocolFamily: entry.manifest.protocolFamily,
      curationTier: entry.manifest.curationTier,
      trustTier: entry.trustTier,
      enabledForQuery: entry.enabledForQuery
    },
    searchFields: [
      { label: 'database', value: entry.manifest.id, weight: 25 },
      { label: 'domain', value: domain.id, weight: 80 },
      { label: 'summary', value: domain.summary, weight: 35 },
      { label: 'common_fields', value: domain.commonFields.join(' '), weight: 30 },
      {
        label: 'fields',
        value: (domain.fields ?? []).map((field) => field.name).join(' '),
        weight: 15
      }
    ]
  }
}

function fieldDocsCandidates(
  entry: DbConnectorCatalogEntry,
  domain: DbDomainManifest
): DbDocsSearchCandidate[] {
  const commonFields = new Set(domain.commonFields)
  const candidates = (domain.fields ?? []).map((field) =>
    fieldDocsCandidate(entry, domain, field, commonFields.has(field.name))
  )
  const describedFields = new Set((domain.fields ?? []).map((field) => field.name))
  for (const commonField of domain.commonFields) {
    if (describedFields.has(commonField)) continue
    candidates.push(fieldDocsCandidate(entry, domain, { name: commonField, type: 'string' }, true))
  }
  return candidates
}

function fieldDocsCandidate(
  entry: DbConnectorCatalogEntry,
  domain: DbDomainManifest,
  field: DbFieldSchema,
  common: boolean
): DbDocsSearchCandidate {
  const snippet = field.description ?? `${field.name} is listed as a common field for ${domain.id}.`
  return {
    result: {
      kind: 'field',
      database: entry.manifest.id,
      domain: domain.id,
      field: field.name,
      title: `${entry.manifest.id}/${domain.id}/${field.name}`,
      snippet,
      protocolFamily: entry.manifest.protocolFamily,
      curationTier: entry.manifest.curationTier,
      trustTier: entry.trustTier,
      enabledForQuery: entry.enabledForQuery,
      type: field.type,
      namespace: field.namespace,
      synonyms: field.synonyms,
      nullable: field.nullable,
      common
    },
    searchFields: [
      { label: 'database', value: entry.manifest.id, weight: 20 },
      { label: 'domain', value: domain.id, weight: 25 },
      { label: 'field', value: field.name, weight: 100 },
      { label: 'type', value: field.type, weight: 10 },
      { label: 'namespace', value: field.namespace ?? '', weight: 70 },
      { label: 'synonyms', value: (field.synonyms ?? []).join(' '), weight: 75 },
      { label: 'description', value: field.description ?? '', weight: 35 },
      { label: 'domain_summary', value: domain.summary, weight: 10 }
    ]
  }
}

function xrefDocsCandidate(
  entry: DbConnectorCatalogEntry,
  xref: DbXrefRule
): DbDocsSearchCandidate {
  const fromDatabase = xref.from.database ?? entry.manifest.id
  const toDatabase = xref.to.database ?? entry.manifest.id
  const title = `${fromDatabase}/${xref.from.domain}.${xref.from.field} -> ${toDatabase}/${xref.to.domain}.${xref.to.field}`
  const snippet = `Cross-reference from ${xref.from.namespace ?? xref.from.field} to ${xref.to.namespace ?? xref.to.field}.`
  return {
    result: {
      kind: 'xref',
      database: entry.manifest.id,
      domain: xref.from.domain,
      title,
      snippet,
      protocolFamily: entry.manifest.protocolFamily,
      curationTier: entry.manifest.curationTier,
      trustTier: entry.trustTier,
      enabledForQuery: entry.enabledForQuery,
      xref: { from: xref.from, to: xref.to }
    },
    searchFields: [
      { label: 'database', value: entry.manifest.id, weight: 20 },
      { label: 'from_database', value: fromDatabase, weight: 20 },
      { label: 'from_domain', value: xref.from.domain, weight: 30 },
      { label: 'from_field', value: xref.from.field, weight: 60 },
      { label: 'from_namespace', value: xref.from.namespace ?? '', weight: 70 },
      { label: 'from_species', value: xref.from.species ?? '', weight: 40 },
      { label: 'to_database', value: toDatabase, weight: 20 },
      { label: 'to_domain', value: xref.to.domain, weight: 30 },
      { label: 'to_field', value: xref.to.field, weight: 60 },
      { label: 'to_namespace', value: xref.to.namespace ?? '', weight: 70 },
      { label: 'to_species', value: xref.to.species ?? '', weight: 40 }
    ]
  }
}

function docsSearchResults(
  entries: DbConnectorCatalogEntry[],
  options: {
    query: string
    database?: string
    domain?: string
    limit: number
  }
): DbDocsSearchResult[] {
  const tokens = tokenizeDocsQuery(options.query)
  return entries
    .filter((entry) => !options.database || entry.manifest.id === options.database)
    .flatMap(docsSearchCandidates)
    .filter((candidate) => !options.domain || candidate.result.domain === options.domain)
    .map((candidate) => ({ candidate, score: scoreDocsCandidate(candidate, tokens) }))
    .filter(({ score }) => tokens.length === 0 || score.score > 0)
    .sort((left, right) => {
      if (right.score.score !== left.score.score) return right.score.score - left.score.score
      return left.candidate.result.title.localeCompare(right.candidate.result.title)
    })
    .slice(0, options.limit)
    .map(({ candidate, score }) => ({
      ...candidate.result,
      score: score.score,
      matchReasons: score.matchReasons
    }))
}

function tokenizeDocsQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;，；/]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
}

function scoreDocsCandidate(
  candidate: DbDocsSearchCandidate,
  tokens: string[]
): { score: number; matchReasons: string[] } {
  if (tokens.length === 0) return { score: 1, matchReasons: ['listed'] }
  let score = 0
  const matchReasons = new Set<string>()
  for (const token of tokens) {
    for (const field of candidate.searchFields) {
      const value = field.value.toLowerCase()
      if (!value) continue
      if (value === token) {
        score += field.weight * 3
        matchReasons.add(`${field.label}:exact`)
      } else if (value.split(/\W+/).includes(token)) {
        score += field.weight * 2
        matchReasons.add(`${field.label}:word`)
      } else if (value.includes(token)) {
        score += field.weight
        matchReasons.add(`${field.label}:partial`)
      }
    }
  }
  return { score, matchReasons: Array.from(matchReasons).sort() }
}

function dbQueryErrorContent(error: unknown): string {
  if (error instanceof DbHttpError) {
    return `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

function localDbQueryErrorDetails(
  code: DbQueryToolErrorCode,
  message: string
): DbQueryToolErrorDetails {
  return { kind: 'db_query_error', code, message, retryable: false }
}

function dbQueryErrorDetails(error: unknown): DbQueryToolErrorDetails {
  if (error instanceof DbHttpError) {
    return {
      kind: 'db_query_error',
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      attempts: error.attempts,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.lastStatus === undefined ? {} : { lastStatus: error.lastStatus }),
      ...(error.nextSuggestedWaitMs === undefined
        ? {}
        : { nextSuggestedWaitMs: error.nextSuggestedWaitMs }),
      safeDetails: error.safeDetails
    }
  }
  return localDbQueryErrorDetails('query_failed', dbQueryErrorContent(error))
}

function resolveDbQueryInput(
  record: Record<string, unknown>,
  catalog: DbConnectorCatalogEntry[]
): ResolvedDbQueryInput | { error: string } {
  const explicitDatabase = stringParam(record.database)
  const explicitDomain = stringParam(record.domain)
  const querySource = querySourceParam(record)
  const queryText = querySource?.value
  const explicitFilters = filtersParam(record.filters)
  const explicitRawQuery = stringParam(record.rawQuery)
  const explicitFields = fieldsParam(record.fields)
  const reasons: string[] = []

  let entry = explicitDatabase
    ? catalog.find((candidate) => candidate.manifest.id === explicitDatabase)
    : undefined
  let domain = explicitDomain
  let targetSource: DbResolvedQuery['targetSource'] =
    explicitDatabase && explicitDomain ? 'explicit' : 'heuristic'

  if (!entry && explicitDatabase) {
    return {
      database: explicitDatabase,
      domain: explicitDomain ?? '',
      filters: explicitFilters,
      fields: explicitFields,
      rawQuery: explicitRawQuery,
      resolvedQuery: {
        database: explicitDatabase,
        domain: explicitDomain ?? '',
        inferred: false,
        targetSource: 'explicit',
        predicateSource: explicitFilters || explicitRawQuery ? 'explicit' : 'none',
        ...(querySource ? { input: { source: querySource.source, text: querySource.value } } : {}),
        ...(explicitFilters ? { filters: explicitFilters } : {}),
        ...(explicitFields ? { fields: explicitFields } : {}),
        ...(explicitRawQuery ? { rawQuery: explicitRawQuery } : {}),
        reasons: ['database was provided explicitly; catalog validation will report if missing']
      }
    }
  }

  if (!entry || !domain) {
    const inferred = inferDbQueryTarget({
      queryText,
      catalog,
      database: explicitDatabase,
      domain: explicitDomain
    })
    if (!inferred) {
      return {
        error: 'db_query 需要 database/domain，或能推断数据库与 domain 的 query/term/keyword。'
      }
    }
    entry = inferred.entry
    domain = inferred.domain.id
    targetSource = inferred.targetSource
    reasons.push(
      inferred.targetSource === 'single_candidate'
        ? `selected ${entry.manifest.id}/${domain} because it is the only matching enabled catalog candidate`
        : `selected ${entry.manifest.id}/${domain} from ${querySource?.source ?? 'query'} intent${
            inferred.score === undefined ? '' : ` (score ${inferred.score})`
          }`
    )
  } else {
    reasons.push(`database/domain provided explicitly as ${entry.manifest.id}/${domain}`)
  }

  const inferredQuery =
    !explicitFilters && !explicitRawQuery && queryText
      ? inferQueryPredicate(entry.manifest.id, domain, queryText)
      : {}
  const filters = explicitFilters ?? inferredQuery.filters
  const rawQuery = explicitRawQuery ?? inferredQuery.rawQuery
  const predicateSource: DbResolvedQuery['predicateSource'] =
    explicitFilters || explicitRawQuery
      ? 'explicit'
      : inferredQuery.filters || inferredQuery.rawQuery
        ? 'heuristic'
        : 'none'

  if (explicitFilters) {
    reasons.push('filters were provided explicitly')
  } else if (explicitRawQuery) {
    reasons.push('rawQuery was provided explicitly')
  } else if (inferredQuery.filters) {
    reasons.push('converted query text into portable filters')
  } else if (inferredQuery.rawQuery) {
    reasons.push('converted query text into rawQuery for the selected domain')
  }
  if (explicitFields) reasons.push('fields were provided explicitly')

  return {
    database: entry.manifest.id,
    domain,
    filters,
    fields: explicitFields,
    rawQuery,
    resolvedQuery: {
      database: entry.manifest.id,
      domain,
      inferred: targetSource !== 'explicit' || predicateSource === 'heuristic',
      targetSource,
      predicateSource,
      ...(querySource ? { input: { source: querySource.source, text: querySource.value } } : {}),
      ...(filters ? { filters } : {}),
      ...(explicitFields ? { fields: explicitFields } : {}),
      ...(rawQuery ? { rawQuery } : {}),
      reasons
    }
  }
}

function inferDbQueryTarget({
  queryText,
  catalog,
  database,
  domain
}: {
  queryText?: string
  catalog: DbConnectorCatalogEntry[]
  database?: string
  domain?: string
}):
  | {
      entry: DbConnectorCatalogEntry
      domain: DbDomainManifest
      targetSource: Extract<DbResolvedQuery['targetSource'], 'single_candidate' | 'heuristic'>
      score?: number
    }
  | undefined {
  const candidates = catalog
    .filter((entry) => !database || entry.manifest.id === database)
    .filter((entry) => Boolean(database) || entry.enabledForQuery)
    .flatMap((entry) =>
      entry.manifest.domains
        .filter((candidate) => !domain || candidate.id === domain)
        .map((candidate) => ({ entry, domain: candidate }))
    )

  if (candidates.length === 1) {
    return { ...candidates[0], targetSource: 'single_candidate' }
  }
  if (!queryText) return undefined

  const scored = candidates
    .map((candidate) => ({ ...candidate, score: scoreDbQueryTarget(candidate, queryText) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return `${left.entry.manifest.id}/${left.domain.id}`.localeCompare(
        `${right.entry.manifest.id}/${right.domain.id}`
      )
    })
  const match = scored[0]
  return match
    ? {
        entry: match.entry,
        domain: match.domain,
        targetSource: 'heuristic',
        score: match.score
      }
    : undefined
}

function scoreDbQueryTarget(
  candidate: { entry: DbConnectorCatalogEntry; domain: DbDomainManifest },
  queryText: string
): number {
  const query = queryText.toLowerCase()
  const { entry, domain } = candidate
  let score = 0
  if (query.includes(entry.manifest.id.toLowerCase())) score += 120
  if (query.includes(entry.manifest.name.toLowerCase())) score += 80
  if (query.includes(domain.id.toLowerCase())) score += 60
  if (entry.manifest.curationTier === 'curated') score += 5

  if (entry.manifest.id === 'entrez/ncbi') {
    if (/\bncbi\b|\bentrez\b/.test(query)) score += 80
    if (
      domain.id === 'pubmed' &&
      /\bpubmed\b|\bpmid\b|\bdoi\b|\bpaper\b|\babstract\b|\bliterature\b|\barticle\b/.test(query)
    )
      score += 150
    if (
      domain.id === 'clinvar' &&
      /\bclinvar\b|\bvariant\b|\bvariation\b|\bpathogenic\b|\bclinical\b/.test(query)
    )
      score += 150
    if (domain.id === 'protein') {
      if (/\brefseq\b|\bfasta\b|\b(?:NP|XP|YP|WP|AP)_\d+(?:\.\d+)?\b/.test(query)) {
        score += 160
      }
      if (
        /\bncbi\b|\bentrez\b/.test(query) &&
        /\bprotein\b|\bsequence\b|\bamino\s+acid\b/.test(query)
      ) {
        score += 150
      }
      if (/\bprotein\b|\baccession\b|\bfasta\b|\bsequence\b|\bamino\s+acid\b/.test(query)) {
        score += 35
      }
    }
    if (domain.id === 'nucleotide') {
      if (/\b(?:NC|NG|NM|NR|XM|XR|NT|NW|AC|AP|CP|CM)_\d+(?:\.\d+)?\b/.test(query)) {
        score += 170
      }
      if (/\bnucleotide\b|\bnuccore\b|\bdna\b|\brna\b|\bmrna\b|\bgenbank\b/.test(query)) {
        score += 150
      }
      if (/\bncbi\b|\bentrez\b/.test(query) && /\bsequence\b|\bfasta\b/.test(query)) {
        score += 45
      }
    }
    if (domain.id === 'biosample') {
      if (/\b(?:SAMN|SAMEA|SAMD)\d+\b/i.test(queryText)) score += 180
      if (
        /\bbiosample\b|\bsample\s+metadata\b|\bsample\s+attribute|\bgeo_loc_name\b|\bisolation\s+source\b|\btissue\b/.test(
          query
        )
      )
        score += 150
    }
    if (domain.id === 'sra') {
      if (/\b(?:SRR|SRX|SRP|SRS|SRA|ERR|ERX|ERP|ERS|DRR|DRX|DRP|DRS)\d+\b/i.test(queryText)) {
        score += 185
      }
      if (
        /\bsra\b|\bsequence\s+read\s+archive\b|\bsequencing\s+run\b|\breads?\s+archive\b|\bexperiment\s+accession\b|\brna-?seq\s+run\b/.test(
          query
        )
      ) {
        score += 150
      }
    }
    if (domain.id === 'geo') {
      if (/\b(?:GSE|GSM|GPL|GDS)\d+\b/i.test(queryText)) score += 185
      if (
        /\bgeo\b|\bgene\s+expression\s+omnibus\b|\bgds\b|\bgeo\s+datasets?\b|\bexpression\s+profil(?:e|ing)\b|\bmicroarray\b|\bseries\s+accession\b|\bplatform\s+accession\b/.test(
          query
        )
      ) {
        score += 150
      }
    }
    if (domain.id === 'bioproject') {
      if (/\bPRJ(?:NA|EB|DB)\d+\b/i.test(queryText)) score += 185
      if (
        /\bbioproject\b|\bbio\s+project\b|\bproject\s+accession\b|\bproject\s+metadata\b|\bproject\s+data\s+type\b|\bsubmitter\s+organization\b/.test(
          query
        )
      ) {
        score += 150
      }
    }
    if (
      domain.id === 'taxonomy' &&
      /\btaxonomy\b|\btaxon\b|\btaxid\b|\btaxonomy\s+id\b|\borganism\b|\bspecies\b|\blineage\b/.test(
        query
      )
    )
      score += 150
    if (domain.id === 'gene' && /\bgene\b|\bsymbol\b|\bhgnc\b/.test(query)) score += 90
  }

  if (entry.manifest.id === 'rest-json/ensembl') {
    if (/\bensembl\b/.test(query)) score += 150
    if (domain.id === 'gene' && /\bgene\b|\bsymbol\b|\bhgnc\b/.test(query)) score += 30
    const stableId = ensemblStableIdFromText(queryText)
    const variantId = ensemblVariantIdFromText(queryText)
    const hgvs = ensemblHgvsFromText(queryText)
    const requestsVep = /\bvep\b|\bvariant\s+effect\b|\bconsequences?\b/.test(query)
    if (domain.id === 'lookup_id' && stableId && !/\bsequence\b|\bfasta\b/.test(query)) {
      score += 220
    }
    if (domain.id === 'sequence_id' && stableId && /\bsequence\b|\bfasta\b/.test(query)) {
      score += 260
    }
    if (domain.id === 'variation' && variantId && !requestsVep) score += 250
    if (domain.id === 'vep_id' && variantId && requestsVep) score += 300
    if (domain.id === 'vep_hgvs' && hgvs && requestsVep) score += 320
  }

  if (entry.manifest.id === 'rest-json/uniprot') {
    if (/\buniprot\b|\buniprotkb\b/.test(query)) score += 180
    if (
      domain.id === 'id_mapping' &&
      (/\bid\s+mapping\b|\bmap\b|\bmapping\b|\bconvert\b|\bconversion\b|\bxref\b|\bcross-?ref/.test(
        query
      ) ||
        uniprotMappingTargetFromText(queryText))
    ) {
      score += 220
    }
    if (
      domain.id === 'protein' &&
      /\bprotein\b|\baccession\b|\bsequence\b|\bfasta\b|\bamino\s+acid\b|\bswiss-?prot\b|\btrembl\b|\bgo\b|\bpdb\b/.test(
        query
      )
    ) {
      score += 150
    }
    if (uniprotAccessionFromText(queryText)) {
      score += 170
    }
  }

  if (entry.manifest.id === 'sparql/uniprot') {
    if (/\buniprot\b|\bprotein\b|\baccession\b|\bsequence\b|\bamino\s+acid\b/.test(query)) {
      score += 80
    }
  }

  if (extractPrimaryDbQueryTerm(queryText)) {
    if (entry.manifest.id === 'entrez/ncbi' && domain.id === 'gene') score += 35
    if (entry.manifest.id === 'rest-json/ensembl' && domain.id === 'gene') score += 25
    if (entry.manifest.id === 'rest-json/uniprot' && domain.id === 'protein') score += 35
    if (entry.manifest.id === 'rest-json/uniprot' && domain.id === 'id_mapping') score += 25
    if (entry.manifest.id === 'sparql/uniprot' && domain.id === 'protein') score += 20
  }

  return score
}

function inferQueryPredicate(
  database: string,
  domain: string,
  queryText: string
): { filters?: DbFilter[]; rawQuery?: string } {
  const term = extractPrimaryDbQueryTerm(queryText) ?? queryText.trim()
  if (!term) return {}

  if (database === 'entrez/ncbi' && domain === 'gene') {
    return { filters: [{ field: 'gene', op: '=', value: term }] }
  }
  if (database === 'entrez/ncbi' && domain === 'pubmed') {
    return { rawQuery: queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'protein') {
    const organism = /\bhuman\b|\bhomo\s+sapiens\b/i.test(queryText)
      ? ' AND Homo sapiens[organism]'
      : ''
    return { rawQuery: `${term}${organism}` }
  }
  if (database === 'entrez/ncbi' && domain === 'nucleotide') {
    const organism = /\bhuman\b|\bhomo\s+sapiens\b/i.test(queryText)
      ? ' AND Homo sapiens[organism]'
      : ''
    return { rawQuery: `${term}${organism}` }
  }
  if (database === 'entrez/ncbi' && domain === 'biosample') {
    const accession = queryText.match(/\b(?:SAMN|SAMEA|SAMD)\d+\b/i)?.[0]
    const cleaned =
      accession ??
      queryText
        .replace(/\b(?:ncbi|entrez|biosample|sample|metadata|attribute|attributes)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'sra') {
    const accession = queryText.match(
      /\b(?:SRR|SRX|SRP|SRS|SRA|ERR|ERX|ERP|ERS|DRR|DRX|DRP|DRS)\d+\b/i
    )?.[0]
    const cleaned =
      accession ??
      queryText
        .replace(
          /\b(?:ncbi|entrez|sra|sequence\s+read\s+archive|sequencing|run|runs|experiment|accession|metadata)\b/gi,
          ' '
        )
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'geo') {
    const accession = queryText.match(/\b(?:GSE|GSM|GPL|GDS)\d+\b/i)?.[0]
    const cleaned =
      accession ??
      queryText
        .replace(
          /\b(?:ncbi|entrez|geo|gene\s+expression\s+omnibus|gds|datasets?|series|sample|platform|accession|metadata|expression\s+profiling|expression\s+profile|microarray)\b/gi,
          ' '
        )
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'bioproject') {
    const accession = queryText.match(/\bPRJ(?:NA|EB|DB)\d+\b/i)?.[0]
    const cleaned =
      accession ??
      queryText
        .replace(
          /\b(?:ncbi|entrez|bioproject|bio\s+project|project|accession|metadata|data\s+type|submitter|organization)\b/gi,
          ' '
        )
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'taxonomy') {
    const taxId = queryText.match(/\b(?:taxid|taxon(?:omy)?\s+id)\s*[:#]?\s*(\d+)\b/i)?.[1]
    const cleaned =
      taxId ??
      queryText
        .replace(/\b(?:ncbi|entrez|taxonomy|taxon|taxid|organism|species|lineage)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: taxId ? `${taxId}[uid]` : cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'clinvar') {
    return { rawQuery: looksLikeClinvarAccession(term) ? term : `${term}[gene]` }
  }
  if (database === 'rest-json/ensembl' && (domain === 'gene' || domain === 'xref')) {
    return { filters: [{ field: 'symbol', op: '=', value: term }] }
  }
  if (database === 'rest-json/ensembl' && domain === 'lookup_id') {
    return {
      filters: [{ field: 'id', op: '=', value: ensemblStableIdFromText(queryText) ?? term }]
    }
  }
  if (database === 'rest-json/ensembl' && domain === 'sequence_id') {
    return {
      filters: [{ field: 'id', op: '=', value: ensemblStableIdFromText(queryText) ?? term }]
    }
  }
  if (database === 'rest-json/ensembl' && domain === 'variation') {
    return {
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'id', op: '=', value: ensemblVariantIdFromText(queryText) ?? term }
      ]
    }
  }
  if (database === 'rest-json/ensembl' && domain === 'vep_id') {
    return {
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'id', op: '=', value: ensemblVariantIdFromText(queryText) ?? term }
      ]
    }
  }
  if (database === 'rest-json/ensembl' && domain === 'vep_hgvs') {
    return {
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'hgvs', op: '=', value: ensemblHgvsFromText(queryText) ?? term }
      ]
    }
  }
  if (database === 'rest-json/uniprot' && domain === 'protein') {
    const accession = uniprotAccessionFromText(queryText)
    return accession
      ? { filters: [{ field: 'accession', op: '=', value: accession }] }
      : { filters: [{ field: 'gene_name', op: '=', value: term }] }
  }
  if (database === 'rest-json/uniprot' && domain === 'id_mapping') {
    const accession = uniprotAccessionFromText(queryText) ?? term
    return {
      filters: [
        { field: 'from', op: '=', value: 'UniProtKB_AC-ID' },
        { field: 'to', op: '=', value: uniprotMappingTargetFromText(queryText) ?? 'Ensembl' },
        { field: 'ids', op: 'in', value: [accession] }
      ]
    }
  }
  if (database === 'sparql/uniprot' && domain === 'protein') {
    return { filters: [{ field: 'gene_name', op: '=', value: term }] }
  }

  return { rawQuery: queryText.trim() }
}

const DB_QUERY_TERM_STOPWORDS = new Set([
  'NCBI',
  'ENTREZ',
  'PUBMED',
  'PMID',
  'DOI',
  'CLINVAR',
  'ENSEMBL',
  'UNIPROT',
  'REFSEQ',
  'SEQUENCE',
  'FASTA',
  'NUCLEOTIDE',
  'NUCLEOTIDES',
  'NUCCORE',
  'BIOSAMPLE',
  'SAMPLE',
  'SAMPLES',
  'METADATA',
  'ATTRIBUTE',
  'ATTRIBUTES',
  'SRA',
  'SRR',
  'SRX',
  'SRP',
  'SRS',
  'RUN',
  'RUNS',
  'EXPERIMENT',
  'GEO',
  'GDS',
  'GSE',
  'GSM',
  'GPL',
  'DATASET',
  'DATASETS',
  'SERIES',
  'PLATFORM',
  'PLATFORMS',
  'MICROARRAY',
  'OMNIBUS',
  'BIOPROJECT',
  'PROJECT',
  'PROJECTS',
  'PRJNA',
  'PRJEB',
  'PRJDB',
  'SUBMITTER',
  'ORGANIZATION',
  'TAXONOMY',
  'TAXON',
  'TAXID',
  'ORGANISM',
  'SPECIES',
  'LINEAGE',
  'GENBANK',
  'DNA',
  'RNA',
  'MRNA',
  'AMINO',
  'ACID',
  'GENE',
  'GENES',
  'PROTEIN',
  'PROTEINS',
  'VARIANT',
  'VARIANTS',
  'HUMAN',
  'HOMO',
  'SAPIENS'
])

function extractPrimaryDbQueryTerm(queryText: string): string | undefined {
  const tokens = queryText.match(/[A-Za-z][A-Za-z0-9_.-]{1,30}/g) ?? []
  return tokens.find((token) => {
    const upper = token.toUpperCase()
    if (DB_QUERY_TERM_STOPWORDS.has(upper)) return false
    return /\d/.test(token) || token === upper
  })
}

function looksLikeClinvarAccession(value: string): boolean {
  return /^(VCV|RCV|SCV)\d+$/i.test(value)
}

function uniprotAccessionFromText(value: string): string | undefined {
  return value.match(/\b(?:[A-NR-Z][0-9][A-Z0-9]{3}[0-9]|[A-Z][0-9][A-Z0-9]{3}[0-9]-\d+)\b/)?.[0]
}

function uniprotMappingTargetFromText(value: string): string | undefined {
  const query = value.toLowerCase()
  if (/\bensembl\b/.test(query)) return 'Ensembl'
  if (/\bpdb\b|\bprotein\s+data\s+bank\b/.test(query)) return 'PDB'
  if (/\brefseq\s+protein\b|\brefseq_protein\b/.test(query)) return 'RefSeq_Protein'
  if (/\brefseq\b|\brefseq\s+(?:nucleotide|rna|dna)\b/.test(query)) return 'RefSeq_Nucleotide'
  if (/\bgeneid\b|\bgene\s+id\b|\bncbi\s+gene\b/.test(query)) return 'GeneID'
  if (/\bembl\b/.test(query)) return 'EMBL'
  if (/\buniparc\b/.test(query)) return 'UniParc'
  return undefined
}

function ensemblStableIdFromText(value: string): string | undefined {
  return value.match(/\bENS[A-Z]*\d+(?:\.\d+)?\b/i)?.[0].toUpperCase()
}

function ensemblVariantIdFromText(value: string): string | undefined {
  return value.match(/\brs\d+\b/i)?.[0].toLowerCase()
}

function ensemblHgvsFromText(value: string): string | undefined {
  return value.match(/\b(?:[A-Z]{1,4}_\d+(?:\.\d+)?:)?[\w.-]+:[cgmnpr]\.\S+/i)?.[0]
}

export function buildDbSearchTool(agentDir: string = getPhiAgentDir()): CustomTool {
  return {
    name: 'db_search',
    label: 'Search Databases',
    description: `Search installed Phi biological database connectors and domains. ${DB_TOOL_ROUTING_HINT} Start here when the user asks which biological database can answer a request, then use db_domain/db_docs_search/db_query.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        protocolFamily: { type: 'string' },
        curationTier: { type: 'string' },
        trustTier: { type: 'string' }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const query = typeof record.query === 'string' ? record.query.trim().toLowerCase() : ''
      const results = listDbConnectorCatalog(agentDir)
        .filter((entry) => {
          if (
            typeof record.protocolFamily === 'string' &&
            entry.manifest.protocolFamily !== record.protocolFamily
          ) {
            return false
          }
          if (
            typeof record.curationTier === 'string' &&
            entry.manifest.curationTier !== record.curationTier
          ) {
            return false
          }
          if (typeof record.trustTier === 'string' && entry.trustTier !== record.trustTier) {
            return false
          }
          if (!query) return true
          const haystack = `${entry.manifest.id} ${entry.manifest.name} ${entry.manifest.domains
            .map((domain) => `${domain.id} ${domain.summary}`)
            .join(' ')}`.toLowerCase()
          return haystack.includes(query)
        })
        .map(catalogSearchItem)
      return {
        content: [
          {
            type: 'text',
            text: results.length ? JSON.stringify(results, null, 2) : '没有找到匹配的数据库连接器。'
          }
        ],
        details: { kind: 'db_search_results', results }
      }
    }
  }
}

export function buildDbDomainTool(agentDir: string = getPhiAgentDir()): CustomTool {
  return {
    name: 'db_domain',
    label: 'Describe Database Domain',
    description: `Get fields and summary for one biological database domain before querying. ${DB_TOOL_ROUTING_HINT}`,
    parameters: {
      type: 'object',
      required: ['database', 'domain'],
      properties: {
        database: { type: 'string' },
        domain: { type: 'string' }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const database = typeof record.database === 'string' ? record.database : ''
      const domainId = typeof record.domain === 'string' ? record.domain : ''
      const entry = findDbConnectorCatalogEntry(database, agentDir)
      const domain = entry?.manifest.domains.find((candidate) => candidate.id === domainId)
      if (!entry || !domain) {
        return {
          content: [{ type: 'text', text: `未找到 domain: ${database}/${domainId}` }],
          isError: true
        }
      }
      const details = {
        kind: 'db_domain',
        database,
        domain: domain.id,
        summary: domain.summary,
        commonFields: domain.commonFields,
        standardFields: [...DB_STANDARD_RECORD_FIELDS],
        fields: domain.fields ?? [],
        identity: domain.identity
      }
      return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }], details }
    }
  }
}

export function buildDbQueryTool(
  adapters: Record<string, DbAdapter>,
  agentDir: string = getPhiAgentDir()
): CustomTool {
  return {
    name: 'db_query',
    label: 'Query Database',
    description: `Run a read-only structured query against an enabled biological database connector. ${DB_TOOL_ROUTING_HINT} Use filters or rawQuery from the user intent; large results are written to an artifact and summarized.`,
    parameters: {
      type: 'object',
      properties: {
        database: { type: 'string' },
        domain: { type: 'string' },
        query: { type: 'string' },
        term: { type: 'string' },
        keyword: { type: 'string' },
        filters: { type: 'array' },
        fields: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', default: 50, maximum: 500 },
        maxPages: { type: 'integer', default: 1, minimum: 1, maximum: MAX_DB_QUERY_PAGES },
        cursor: { type: 'string' },
        rawQuery: { type: 'string' }
      }
    },
    approval: 'read',
    async execute(toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const catalog = listDbConnectorCatalog(agentDir)
      const resolved = resolveDbQueryInput(record, catalog)
      if ('error' in resolved) {
        return {
          content: [{ type: 'text', text: resolved.error }],
          isError: true,
          details: localDbQueryErrorDetails('invalid_query', resolved.error)
        }
      }
      const { database, domain } = resolved
      const entry =
        catalog.find((candidate) => candidate.manifest.id === database) ??
        findDbConnectorCatalogEntry(database, agentDir)
      if (!entry) {
        const message = `未找到数据库连接器: ${database}`
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          details: localDbQueryErrorDetails('connector_not_found', message)
        }
      }
      if (!entry.enabledForQuery) {
        const message = `数据库连接器尚未启用查询: ${database}`
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          details: localDbQueryErrorDetails('connector_not_enabled', message)
        }
      }
      if (resolved.filters !== undefined && resolved.rawQuery !== undefined) {
        const message = 'filters 与 rawQuery 不能同时使用。'
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          details: localDbQueryErrorDetails('invalid_query', message)
        }
      }
      const adapter = adapters[database]
      if (!adapter) {
        const message = `缺少数据库 adapter: ${database}`
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          details: localDbQueryErrorDetails('adapter_missing', message)
        }
      }
      try {
        const settings = readAppSettings(agentDir)
        const limit =
          typeof record.limit === 'number' && Number.isFinite(record.limit)
            ? Math.min(Math.max(1, Math.floor(record.limit)), 500)
            : 50
        const maxPages =
          typeof record.maxPages === 'number' && Number.isFinite(record.maxPages)
            ? Math.min(Math.max(1, Math.floor(record.maxPages)), MAX_DB_QUERY_PAGES)
            : 1
        const result = await queryDbAdapterPages(
          adapter,
          {
            domain,
            filters: resolved.filters,
            fields: resolved.fields,
            limit,
            cursor: typeof record.cursor === 'string' ? record.cursor : undefined,
            rawQuery: resolved.rawQuery
          },
          {
            defaultProxyMode: settings.defaultProxyMode,
            proxyTransport: getDbProxyTransport()
          },
          maxPages
        )
        const details = buildDbQueryToolDetails(result, {
          agentDir,
          fileStem: `${database}-${domain}-${toolCallId}`,
          resolvedQuery: resolved.resolvedQuery
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
          details,
          ...(details.mode === 'artifact'
            ? {
                outputPath: details.outputPath,
                outputArtifact: details.outputArtifact,
                outputBytes: details.outputArtifact.bytes,
                truncated: true
              }
            : {})
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: dbQueryErrorContent(error) }],
          isError: true,
          details: dbQueryErrorDetails(error)
        }
      }
    }
  }
}

export function buildDbDocsSearchTool(agentDir: string = getPhiAgentDir()): CustomTool {
  return {
    name: 'db_docs_search',
    label: 'Search Database Docs',
    description: `Search DB connector docs, domain summaries, field glossary, synonyms, namespaces, and xref hints from installed connector manifests. ${DB_TOOL_ROUTING_HINT}`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        keyword: { type: 'string' },
        database: { type: 'string' },
        domain: { type: 'string' },
        limit: { type: 'integer', default: 20, maximum: 50 }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const query = stringParam(record.query) ?? stringParam(record.keyword) ?? ''
      const database = stringParam(record.database)
      const domain = stringParam(record.domain)
      const limit = Math.min(Math.max(1, Math.floor(numericParam(record.limit) ?? 20)), 50)
      const results = docsSearchResults(listDbConnectorCatalog(agentDir), {
        query,
        database,
        domain,
        limit
      })
      return {
        content: [
          {
            type: 'text',
            text: results.length ? JSON.stringify(results, null, 2) : '没有找到匹配的数据库文档。'
          }
        ],
        details: { kind: 'db_docs_search_results', query, database, domain, results }
      }
    }
  }
}

export function buildDbCustomTools(
  adapters: Record<string, DbAdapter> = {},
  agentDir: string = getPhiAgentDir()
): CustomTool[] {
  return [
    buildDbSearchTool(agentDir),
    buildDbDomainTool(agentDir),
    buildDbQueryTool(adapters, agentDir),
    buildDbDocsSearchTool(agentDir)
  ]
}

export function buildDefaultDbAdapters(
  agentDir: string = getPhiAgentDir(),
  options: DefaultDbAdapterOptions = {}
): Record<string, DbAdapter> {
  const adapters: Record<string, DbAdapter> = {}
  for (const entry of listDbConnectorCatalog(agentDir)) {
    if (entry.manifest.protocolFamily === 'entrez') {
      adapters[entry.manifest.id] = new EntrezAdapter(entry.manifest, options.entrez)
    } else if (entry.manifest.id === 'rest-json/uniprot') {
      adapters[entry.manifest.id] = new UniProtAdapter(entry.manifest, options.restJson)
    } else if (entry.manifest.protocolFamily === 'rest-json') {
      adapters[entry.manifest.id] = new RestJsonAdapter(entry.manifest, options.restJson)
    } else if (entry.manifest.protocolFamily === 'sparql') {
      adapters[entry.manifest.id] = new SparqlAdapter(entry.manifest, options.sparql)
    }
  }
  return adapters
}

export function buildDefaultDbCustomTools(
  agentDir: string = getPhiAgentDir(),
  options: DefaultDbAdapterOptions = {}
): CustomTool[] {
  return buildDbCustomTools(buildDefaultDbAdapters(agentDir, options), agentDir)
}
