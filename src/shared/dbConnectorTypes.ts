import type { DefaultProxyMode } from './appSettingsTypes'

export type DbProtocolFamily =
  'entrez' | 'rest-json' | 'sparql' | 'ontology' | 'bulk-index' | 'generic-http'

export type DbCurationTier = 'curated' | 'generic'
export type DbTrustTier = 'bundled' | 'custom'
export type DbFieldType = 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array'

export interface DbConnectorAuth {
  type: 'none' | 'api_key_query_param' | 'api_key_header' | 'bearer_token'
  envVar?: string
  paramName?: string
  headerName?: string
}

export interface DbConnectorRateLimit {
  withAuth?: { requestsPerSecond: number }
  withoutAuth?: { requestsPerSecond: number }
}

export interface DbConnectorRetryPolicy {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export interface DbConnectorNetworkPolicy {
  allowedHosts: string[]
  allowRedirects?: boolean
}

export interface DbFieldSchema {
  name: string
  type: DbFieldType
  description?: string
  synonyms?: string[]
  namespace?: string
  nullable?: boolean
}

export interface DbRestJsonRequestMapping {
  path: string
  method?: 'GET'
  queryParams?: Record<string, string | number | boolean>
  filterParamMap?: Record<string, string>
  rawQueryParam?: string
  limitParam?: string
  cursorParam?: string
}

export interface DbRestJsonResponseMapping {
  rowsPath?: string
  totalRowsPath?: string
  nextCursorPath?: string
  fieldMap?: Record<string, string>
}

export interface DbRestJsonDomainConfig {
  request: DbRestJsonRequestMapping
  response?: DbRestJsonResponseMapping
}

export interface DbSparqlDomainConfig {
  query: string
  prefixes?: Record<string, string>
}

export interface DbDomainManifest {
  id: string
  dbParam?: string
  summary: string
  commonFields: string[]
  fields?: DbFieldSchema[]
  rest?: DbRestJsonDomainConfig
  sparql?: DbSparqlDomainConfig
}

export interface DbXrefEndpoint {
  database?: string
  domain: string
  field: string
  namespace?: string
  species?: string
}

export interface DbXrefRule {
  from: DbXrefEndpoint
  to: DbXrefEndpoint
}

export interface DbConnectorManifest {
  phiDbConnectorVersion: 1
  id: string
  name: string
  protocolFamily: DbProtocolFamily
  curationTier: DbCurationTier
  baseUrl: string
  networkPolicy: DbConnectorNetworkPolicy
  auth?: DbConnectorAuth
  rateLimit?: DbConnectorRateLimit
  retryPolicy?: DbConnectorRetryPolicy
  domains: DbDomainManifest[]
  xref?: DbXrefRule[]
}

export interface DbConnectorCatalogEntry {
  manifest: DbConnectorManifest
  trustTier: DbTrustTier
  installedPath: string
  installedAt: string
  digest: string
  enabledForQuery: boolean
}

export interface DbManifestParseResult {
  valid: boolean
  errors: string[]
  manifest?: DbConnectorManifest
}

export type DbFilterOp =
  '=' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'between' | 'like' | 'is_null'

export interface DbFilter {
  field: string
  op: DbFilterOp
  value?: unknown
}

export interface DbQueryParams {
  domain: string
  filters?: DbFilter[]
  fields?: string[]
  limit: number
  cursor?: string
  rawQuery?: string
}

export interface DbQueryProvenance {
  database: string
  domain: string
  retrievedAt: string
  sourceVersion?: string
  citations?: string[]
  rawQueryUsed?: boolean
  attempts?: number
  retried?: boolean
  lastStatus?: number
  transportName?: string
  defaultProxyMode?: DefaultProxyMode
}

export interface DbAdapterQueryResult {
  rows: Record<string, unknown>[]
  totalRows?: number
  truncated: boolean
  nextCursor?: string
  provenance: DbQueryProvenance
}

export interface DbResultSummary {
  rowCount: number
  returnedRows: number
  truncated: boolean
  nextCursor?: string
  fields: string[]
  warnings: string[]
}

export interface DbResolvedQuery {
  database: string
  domain: string
  inferred: boolean
  targetSource: 'explicit' | 'single_candidate' | 'heuristic'
  predicateSource: 'explicit' | 'heuristic' | 'none'
  input?: {
    source: 'query' | 'term' | 'keyword'
    text: string
  }
  filters?: DbFilter[]
  fields?: string[]
  rawQuery?: string
  reasons: string[]
}

export interface DbQueryArtifact {
  kind: 'db_query_result'
  path: string
  format: 'jsonl' | 'csv' | 'metadata_json'
  bytes: number
  rowCount?: number
  sha256?: string
}

export type DbQueryToolDetails =
  | {
      kind: 'db_query_result'
      mode: 'inline'
      summary: DbResultSummary
      rows: Record<string, unknown>[]
      provenance: DbQueryProvenance
      resolvedQuery?: DbResolvedQuery
    }
  | {
      kind: 'db_query_result'
      mode: 'artifact'
      summary: DbResultSummary
      sampleRows: Record<string, unknown>[]
      artifact: DbQueryArtifact
      artifacts: DbQueryArtifact[]
      metadataArtifact: DbQueryArtifact
      csvArtifact?: DbQueryArtifact
      outputPath: string
      outputArtifact: { kind: 'tool_output'; path: string; bytes: number }
      provenance: DbQueryProvenance
      resolvedQuery?: DbResolvedQuery
    }

export type KnownDbQueryToolErrorCode =
  | 'connector_not_found'
  | 'connector_not_enabled'
  | 'invalid_query'
  | 'adapter_missing'
  | 'query_failed'
  | 'DB_PROXY_UNAVAILABLE'
  | 'DB_POLICY_BLOCKED'
  | 'DB_HTTP_STATUS'
  | 'DB_REQUEST_FAILED'
  | 'DB_REQUEST_CANCELLED'
  | 'DB_RESPONSE_TOO_LARGE'
  | 'DB_RETRIES_EXHAUSTED'

export type DbQueryToolErrorCode = KnownDbQueryToolErrorCode | (string & {})

export interface DbQueryToolErrorDetails {
  kind: 'db_query_error'
  code: DbQueryToolErrorCode
  message: string
  retryable: boolean
  attempts?: number
  status?: number
  lastStatus?: number
  nextSuggestedWaitMs?: number
  safeDetails?: {
    redactedUrl?: string
    transportName?: string
  }
}

export type DbQueryToolResultDetails = DbQueryToolDetails | DbQueryToolErrorDetails
