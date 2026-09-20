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
import { docsSearchResults } from './tool-docs-search'
import { resolveDbQueryInput } from './tool-query-resolution'
import { DbHttpError, type DbEgressTransport, type DbSleep } from './policy'
import { DB_STANDARD_RECORD_FIELDS } from './adapters/types'
import type { DbAdapter, DbAdapterQueryContext } from './adapters/types'
import type {
  DbAdapterQueryResult,
  DbConnectorCatalogEntry,
  DbQueryParams,
  DbQueryToolErrorCode,
  DbQueryToolErrorDetails
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

const DB_TOOL_ROUTING_HINT =
  'For biological database lookup requests such as NCBI Entrez, PubMed, ClinVar, Ensembl, UniProt, genes, variants, proteins, nucleotide sequences, FASTA records, accessions, and field/schema lookup, infer the database/domain from the user intent and use the db_* tools automatically. Prefer db_* over general web search for structured database records; the user should not need to name tool functions.'

const MAX_DB_QUERY_PAGES = 10

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numericParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

function catalogSearchText(entry: DbConnectorCatalogEntry): string {
  return [
    entry.manifest.id,
    entry.manifest.name,
    ...entry.manifest.domains.flatMap((domain) => [
      domain.id,
      domain.summary,
      ...domain.commonFields,
      ...(domain.fields ?? []).flatMap((field) => [
        field.name,
        field.description ?? '',
        field.namespace ?? '',
        ...(field.synonyms ?? [])
      ])
    ])
  ]
    .join(' ')
    .toLowerCase()
}

function catalogSearchScore(entry: DbConnectorCatalogEntry, terms: string[]): number {
  if (terms.length === 0) return 1
  const haystack = catalogSearchText(entry)
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0)
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
      const queryTerms = query.split(/\s+/).filter(Boolean)
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
          return true
        })
        .map((entry) => ({ entry, score: catalogSearchScore(entry, queryTerms) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score)
        .map(({ entry }) => catalogSearchItem(entry))
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
