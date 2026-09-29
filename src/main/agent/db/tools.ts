import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { readAppSettings } from '../app-settings'
import { getPhiAgentDir } from '../runtime-paths'
import { EntrezAdapter } from './adapters/entrez-adapter'
import { KeggAdapter } from './adapters/kegg-adapter'
import { OntologyAdapter } from './adapters/ontology-adapter'
import { RestJsonAdapter } from './adapters/rest-json-adapter'
import { SparqlAdapter } from './adapters/sparql-adapter'
import { UniProtAdapter } from './adapters/uniprot-adapter'
import { getDbProxyTransport } from './egress-transport'
import { findDbConnectorCatalogEntry, listDbConnectorCatalog } from './catalog'
import { buildDbQueryToolDetails } from './result-writer'
import { buildDbDownloadTool } from './tool-download'
import { docsSearchResults } from './tool-docs-search'
import { buildDbResolveTool } from './tool-resolve'
import {
  buildDbDocsSearchContent,
  buildDbDomainContent,
  buildDbRoutesContent,
  buildDbSearchContent,
  dbRouteQueryInput,
  parseDbDomainDetail
} from './tool-output'
import { resolveDbQueryInput } from './tool-query-resolution'
import { DbHttpError, type DbEgressTransport, type DbSleep } from './policy'
import { DB_STANDARD_RECORD_FIELDS } from './adapters/types'
import { DB_FILTER_OPS } from '../../../shared/dbConnectorTypes'
import {
  enrichDbQueryErrorMessage,
  unknownDatabaseMessage,
  unknownDomainMessage
} from './tool-query-hints'
import type { DbAdapter, DbAdapterQueryContext } from './adapters/types'
import type {
  DbAdapterQueryResult,
  DbConnectorCatalogEntry,
  DbQueryParams,
  DbQueryToolDetails,
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
  ontology?: {
    transport?: DbEgressTransport
    proxyTransport?: DbEgressTransport
    sleep?: DbSleep
    timeoutMs?: number
    now?: () => Date
  }
  kegg?: {
    transport?: DbEgressTransport
    proxyTransport?: DbEgressTransport
    sleep?: DbSleep
    timeoutMs?: number
    now?: () => Date
  }
  download?: {
    transport?: DbEgressTransport
    proxyTransport?: DbEgressTransport
    sleep?: DbSleep
    timeoutMs?: number
    now?: () => Date
  }
}

type DbAdapterFactory = (entry: DbConnectorCatalogEntry) => DbAdapter | undefined

const DB_TOOL_ROUTING_HINT =
  'For biological database lookup requests such as NCBI Entrez, PubMed, ClinVar, Ensembl, UniProt, genes, variants, proteins, sequences, and accessions, first choose relevant databases, then inspect matching functions and their inputs before querying. Prefer db_* over general web search for structured database records; the user should not need to name tool functions.'

const MAX_DB_QUERY_PAGES = 10
const catalogSearchTextCache = new WeakMap<DbConnectorCatalogEntry['manifest'], string>()

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
    enabledForQuery: entry.enabledForQuery
  }
}

function catalogSearchText(entry: DbConnectorCatalogEntry): string {
  const cached = catalogSearchTextCache.get(entry.manifest)
  if (cached) return cached
  const value = [
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
  catalogSearchTextCache.set(entry.manifest, value)
  return value
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

function compactDbRow(
  row: Record<string, unknown>,
  omitDownloadFields: boolean
): Record<string, unknown> {
  const compact: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (omitDownloadFields && (key === 'download_files' || key === 'download_urls')) continue
    compact[key] = compactDbValue(value)
  }
  return compact
}

function compactDbValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > 1200 ? `${value.slice(0, 1200)}…[truncated ${value.length} chars]` : value
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return `[array:${value.length}]`
    const items = value.slice(0, 20).map((item) => compactDbValue(item, depth + 1))
    return value.length > 20 ? [...items, `[${value.length - 20} more]`] : items
  }
  if (isRecord(value)) {
    if (depth >= 2) return `[object:${Object.keys(value).length}]`
    const entries = Object.entries(value)
    const compact: Record<string, unknown> = {}
    for (const [key, item] of entries.slice(0, 20)) compact[key] = compactDbValue(item, depth + 1)
    if (entries.length > 20) compact._omittedKeys = entries.length - 20
    return compact
  }
  return value
}

function compactArtifacts(details: DbQueryToolDetails): Array<Record<string, unknown>> | undefined {
  const artifacts = 'artifacts' in details ? details.artifacts : undefined
  return artifacts?.map((artifact) => ({
    format: artifact.format,
    path: artifact.path,
    bytes: artifact.bytes,
    ...(artifact.rowCount === undefined ? {} : { rowCount: artifact.rowCount })
  }))
}

function buildDbQueryToolContent(details: DbQueryToolDetails): string {
  const hasDownloadManifest = Boolean(details.downloadManifestArtifact)
  const rows =
    details.mode === 'inline'
      ? details.rows.map((row) => compactDbRow(row, hasDownloadManifest))
      : details.sampleRows.map((row) => compactDbRow(row, hasDownloadManifest))
  const content = {
    kind: 'db_query_result_content',
    mode: details.mode,
    summary: details.summary,
    provenance: {
      database: details.provenance.database,
      domain: details.provenance.domain,
      retrievedAt: details.provenance.retrievedAt,
      ...(details.provenance.pagesFetched === undefined
        ? {}
        : { pagesFetched: details.provenance.pagesFetched })
    },
    ...(details.resolvedQuery
      ? {
          resolvedQuery: {
            database: details.resolvedQuery.database,
            domain: details.resolvedQuery.domain,
            inferred: details.resolvedQuery.inferred,
            ...(details.resolvedQuery.input ? { input: details.resolvedQuery.input } : {}),
            ...(details.resolvedQuery.filters ? { filters: details.resolvedQuery.filters } : {}),
            ...(details.resolvedQuery.rawQuery ? { rawQuery: details.resolvedQuery.rawQuery } : {})
          }
        }
      : {}),
    [details.mode === 'inline' ? 'rows' : 'sampleRows']: rows,
    ...(details.mode === 'artifact'
      ? {
          artifact: {
            format: details.artifact.format,
            path: details.artifact.path,
            bytes: details.artifact.bytes,
            rowCount: details.artifact.rowCount
          }
        }
      : {}),
    ...(details.viewerHints ? { viewerHints: details.viewerHints } : {}),
    ...(hasDownloadManifest
      ? {
          download: {
            manifestPath: details.downloadManifestArtifact?.path,
            summary: details.downloadManifestSummary,
            plan: details.downloadPlan,
            instructions: details.downloadInstructions
          }
        }
      : {}),
    ...(compactArtifacts(details) ? { artifacts: compactArtifacts(details) } : {})
  }
  return JSON.stringify(content)
}

export function buildDbSearchTool(agentDir: string = getPhiAgentDir()): CustomTool {
  return {
    name: 'db_search',
    label: 'Search Databases',
    description: `Choose which installed biological databases fit the user's evidence need. This first stage returns database identities only, never domain schemas. It shows at most 8 databases by default; raise limit if needed. ${DB_TOOL_ROUTING_HINT} After choosing one or more databases, call db_routes for each selected database.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        protocolFamily: { type: 'string' },
        curationTier: { type: 'string' },
        trustTier: { type: 'string' },
        limit: { type: 'integer', default: 8, minimum: 1, maximum: 50 }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const query = typeof record.query === 'string' ? record.query.trim().toLowerCase() : ''
      const queryTerms = query.split(/\s+/).filter(Boolean)
      const limit = Math.min(Math.max(1, Math.floor(numericParam(record.limit) ?? 8)), 50)
      const matched = listDbConnectorCatalog(agentDir)
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
        .slice(0, limit)
        .map(({ entry }) => entry)
      const results = matched.map(catalogSearchItem)
      return {
        content: [
          {
            type: 'text',
            text: results.length ? buildDbSearchContent(matched) : '没有找到匹配的数据库连接器。'
          }
        ],
        details: { kind: 'db_search_results', results }
      }
    }
  }
}

export function buildDbRoutesTool(
  agentDir: string = getPhiAgentDir(),
  onRoutes?: (database: string, domains: string[]) => void
): CustomTool {
  return {
    name: 'db_routes',
    label: 'Find Database Functions',
    description:
      'Within one selected database, find functions matching the specific evidence or operation needed. Returns a small list of route purposes and input field names, without full schemas. Call it for each selected database; independent calls may run in parallel. Then inspect each chosen route with db_domain.',
    parameters: {
      type: 'object',
      required: ['database', 'intent'],
      properties: {
        database: { type: 'string', description: 'One database id returned by db_search.' },
        intent: { type: 'string', description: 'The specific function or evidence to retrieve.' },
        limit: { type: 'integer', default: 5, minimum: 1, maximum: 10 }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const database = stringParam(record.database)
      const intent = stringParam(record.intent)
      if (!database || !intent) {
        return {
          content: [{ type: 'text', text: 'db_routes 需要已选定的 database 和具体 intent。' }],
          isError: true
        }
      }
      const entry = findDbConnectorCatalogEntry(database, agentDir)
      if (!entry) {
        return {
          content: [{ type: 'text', text: `未找到数据库连接器: ${database}` }],
          isError: true
        }
      }
      const limit = Math.min(Math.max(1, Math.floor(numericParam(record.limit) ?? 5)), 10)
      const content = buildDbRoutesContent(entry, intent, limit)
      const result = JSON.parse(content) as {
        database: string
        routes: Array<{ domain: string }>
      }
      onRoutes?.(
        database,
        result.routes.map((route) => route.domain)
      )
      return {
        content: [{ type: 'text', text: content }],
        details: { kind: 'db_routes_results', ...result }
      }
    }
  }
}

export function buildDbDomainTool(
  agentDir: string = getPhiAgentDir(),
  routing?: {
    canInspect: (database: string, domain: string) => boolean
    onInspected: (database: string, domain: string) => void
  }
): CustomTool {
  return {
    name: 'db_domain',
    label: 'Describe Database Domain',
    description:
      'After db_routes selects a function, inspect only that domain for required filters, optional filters, an example db_query call, identity, and output fields. Independent chosen domains may be inspected in parallel. Pass detail "all" for every output field in full.',
    parameters: {
      type: 'object',
      required: ['database', 'domain'],
      properties: {
        database: { type: 'string' },
        domain: { type: 'string' },
        detail: {
          type: 'string',
          enum: ['common', 'all'],
          description:
            'Default "common": common fields in full, other fields by name. "all": every field in full.'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const database = typeof record.database === 'string' ? record.database : ''
      const domainId = typeof record.domain === 'string' ? record.domain : ''
      if (routing && !routing.canInspect(database, domainId)) {
        return {
          content: [{ type: 'text', text: `请先用 db_routes 选择 ${database} 中的功能。` }],
          isError: true
        }
      }
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
        identity: domain.identity,
        queryInput: dbRouteQueryInput(database, entry.manifest.protocolFamily, domain)
      }
      routing?.onInspected(database, domainId)
      return {
        content: [
          {
            type: 'text',
            text: buildDbDomainContent(
              database,
              entry.manifest.protocolFamily,
              domain,
              parseDbDomainDetail(record.detail)
            )
          }
        ],
        details
      }
    }
  }
}

export function buildDbQueryTool(
  adapters: Record<string, DbAdapter>,
  agentDir: string = getPhiAgentDir(),
  createAdapter?: DbAdapterFactory,
  routeStatus?: (database: string, domain: string) => 'ready' | 'unrouted' | 'uninspected'
): CustomTool {
  return {
    name: 'db_query',
    label: 'Query Database',
    description:
      'Run a read-only, bounded query against one selected database function. `database` and `domain` are required: use db_search → db_routes → db_domain to choose and inspect it, or use an exact db_resolve result. Follow db_domain.queryInput for required filters and the example; never combine filters with rawQuery. Independent selected queries may run in parallel. Large results are summarized in an artifact. GEO, SRA, UniProt and similar domains may return a download manifest; use db_download only when the user asked to fetch files.',
    parameters: {
      type: 'object',
      required: ['database', 'domain'],
      properties: {
        database: {
          type: 'string',
          description: 'Connector id, for example "rest-json/uniprot" or "entrez/ncbi".'
        },
        domain: {
          type: 'string',
          description: 'Domain id inside that connector, for example "protein" or "geo".'
        },
        filters: {
          type: 'array',
          description:
            'Portable predicates, ANDed together. Field names come from db_domain; each domain accepts only some of them.',
          items: {
            type: 'object',
            required: ['field', 'op'],
            properties: {
              field: { type: 'string' },
              op: { type: 'string', enum: [...DB_FILTER_OPS] },
              value: {
                description:
                  'String, number or boolean; an array for "in"; a two-element array for "between"; omit for "is_null".',
                anyOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } }
                ]
              }
            }
          }
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: "Fields to return; omit for the domain's common fields."
        },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
        maxPages: { type: 'integer', default: 1, minimum: 1, maximum: MAX_DB_QUERY_PAGES },
        cursor: { type: 'string', description: 'nextCursor from a previous truncated result.' },
        rawQuery: {
          type: 'string',
          description: 'Native query syntax of the database. Cannot be combined with filters.'
        }
      }
    },
    approval: 'read',
    async execute(toolCallId, params) {
      const record = isRecord(params) ? params : {}
      const requestedDatabase = stringParam(record.database)
      const requestedEntry = requestedDatabase
        ? findDbConnectorCatalogEntry(requestedDatabase, agentDir)
        : undefined
      const catalog = requestedEntry ? [requestedEntry] : listDbConnectorCatalog(agentDir)
      const resolved = resolveDbQueryInput(record, catalog)
      if ('error' in resolved) {
        return {
          content: [{ type: 'text', text: resolved.error }],
          isError: true,
          details: localDbQueryErrorDetails('invalid_query', resolved.error)
        }
      }
      const { database, domain } = resolved
      const entry = catalog.find((candidate) => candidate.manifest.id === database)
      if (!entry) {
        const message = unknownDatabaseMessage(database, catalog)
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
      if (!entry.manifest.domains.some((candidate) => candidate.id === domain)) {
        const message = unknownDomainMessage(entry, domain)
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          details: localDbQueryErrorDetails('invalid_query', message)
        }
      }
      const status = routeStatus?.(database, domain)
      if (status && status !== 'ready') {
        const message =
          status === 'unrouted'
            ? `请先用 db_routes 选择 ${database} 中的功能，再查看参数。`
            : `请先用 db_domain 查看 ${database}/${domain} 的必填参数和示例。`
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          details: localDbQueryErrorDetails('invalid_query', message)
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
      let adapter: DbAdapter | undefined = adapters[database]
      if (!adapter && createAdapter) {
        adapter = createAdapter(entry)
        if (adapter) adapters[database] = adapter
      }
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
          content: [{ type: 'text', text: buildDbQueryToolContent(details) }],
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
        const message = enrichDbQueryErrorMessage(dbQueryErrorContent(error))
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          details:
            error instanceof DbHttpError
              ? dbQueryErrorDetails(error)
              : localDbQueryErrorDetails('query_failed', message)
        }
      }
    }
  }
}

export function buildDbDocsSearchTool(agentDir: string = getPhiAgentDir()): CustomTool {
  return {
    name: 'db_docs_search',
    label: 'Search Database Docs',
    description:
      'Search a selected database for a specific unresolved field, synonym, namespace or cross-reference. Requires database; use db_search and db_routes first rather than scanning every connector.',
    parameters: {
      type: 'object',
      required: ['database'],
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
      if (!database) {
        return {
          content: [{ type: 'text', text: 'db_docs_search 需要先选定 database。' }],
          isError: true
        }
      }
      const limit = Math.min(Math.max(1, Math.floor(numericParam(record.limit) ?? 20)), 50)
      const entry = findDbConnectorCatalogEntry(database, agentDir)
      if (!entry) {
        return {
          content: [{ type: 'text', text: `未找到数据库连接器: ${database}` }],
          isError: true
        }
      }
      const results = docsSearchResults([entry], {
        query,
        database,
        domain,
        limit
      })
      return {
        content: [
          {
            type: 'text',
            text: results.length ? buildDbDocsSearchContent(results) : '没有找到匹配的数据库文档。'
          }
        ],
        details: { kind: 'db_docs_search_results', query, database, domain, results }
      }
    }
  }
}

export function buildDbCustomTools(
  adapters: Record<string, DbAdapter> = {},
  agentDir: string = getPhiAgentDir(),
  options: Pick<DefaultDbAdapterOptions, 'download'> & {
    createAdapter?: DbAdapterFactory
    enforceRouting?: boolean
  } = {}
): CustomTool[] {
  const routed = new Set<string>()
  const inspected = new Set<string>()
  const key = (database: string, domain: string): string => `${database}\0${domain}`
  const routing = options.enforceRouting
    ? {
        canInspect: (database: string, domain: string) => routed.has(key(database, domain)),
        onInspected: (database: string, domain: string) => {
          inspected.add(key(database, domain))
        }
      }
    : undefined
  return [
    buildDbSearchTool(agentDir),
    buildDbResolveTool(
      agentDir,
      options.enforceRouting
        ? (database, domain) => {
            routed.add(key(database, domain))
            inspected.add(key(database, domain))
          }
        : undefined
    ),
    buildDbRoutesTool(
      agentDir,
      options.enforceRouting
        ? (database, domains) => {
            for (const domain of domains) routed.add(key(database, domain))
          }
        : undefined
    ),
    buildDbDomainTool(agentDir, routing),
    buildDbQueryTool(
      adapters,
      agentDir,
      options.createAdapter,
      options.enforceRouting
        ? (database, domain) => {
            const route = key(database, domain)
            return inspected.has(route) ? 'ready' : routed.has(route) ? 'uninspected' : 'unrouted'
          }
        : undefined
    ),
    buildDbDownloadTool(agentDir, options.download),
    buildDbDocsSearchTool(agentDir)
  ]
}

function createDefaultDbAdapter(
  entry: DbConnectorCatalogEntry,
  options: DefaultDbAdapterOptions
): DbAdapter | undefined {
  const { manifest } = entry
  if (manifest.protocolFamily === 'entrez') return new EntrezAdapter(manifest, options.entrez)
  if (manifest.id === 'rest-json/uniprot') return new UniProtAdapter(manifest, options.restJson)
  if (manifest.id === 'rest-json/kegg') return new KeggAdapter(manifest, options.kegg)
  if (manifest.protocolFamily === 'rest-json')
    return new RestJsonAdapter(manifest, options.restJson)
  if (manifest.protocolFamily === 'sparql') return new SparqlAdapter(manifest, options.sparql)
  if (manifest.protocolFamily === 'ontology') return new OntologyAdapter(manifest, options.ontology)
  return undefined
}

export function buildDefaultDbAdapters(
  agentDir: string = getPhiAgentDir(),
  options: DefaultDbAdapterOptions = {}
): Record<string, DbAdapter> {
  const adapters: Record<string, DbAdapter> = {}
  for (const entry of listDbConnectorCatalog(agentDir)) {
    const adapter = createDefaultDbAdapter(entry, options)
    if (adapter) adapters[entry.manifest.id] = adapter
  }
  return adapters
}

export function buildDefaultDbCustomTools(
  agentDir: string = getPhiAgentDir(),
  options: DefaultDbAdapterOptions = {},
  routing: { enforceRouting?: boolean } = {}
): CustomTool[] {
  return buildDbCustomTools({}, agentDir, {
    download: options.download,
    createAdapter: (entry) => createDefaultDbAdapter(entry, options),
    enforceRouting: routing.enforceRouting
  })
}
