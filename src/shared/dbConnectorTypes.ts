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
  /** When true, queries fail fast if the env/settings secret is missing. */
  required?: boolean
  /** Human-facing label for settings UI, e.g. NCBI API key. */
  label?: string
  /** Where users can request a free/academic key. */
  signupUrl?: string
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
  method?: 'GET' | 'POST'
  idempotent?: boolean
  queryParams?: Record<string, string | number | boolean>
  filterParamMap?: Record<string, string>
  jsonBodyParamMap?: Record<string, string>
  /**
   * Rendered JSON body string fields with `{filter:x}`, `{rawQuery}`, `{limit}`, `{cursor}` tokens.
   * Useful for GraphQL `query` bodies without exposing raw GraphQL to the agent.
   */
  jsonBodyTemplates?: Record<string, string>
  jsonBodyArrayFields?: string[]
  jsonBodyOptionalFields?: string[]
  rawQueryParam?: string
  limitParam?: string
  cursorParam?: string
}

export interface DbRestJsonResponseMapping {
  rowsPath?: string
  totalRowsPath?: string
  nextCursorPath?: string
  fieldMap?: Record<string, string>
  /** Response body format. Defaults to json. Use tsv for tab-delimited text APIs. */
  format?: 'json' | 'tsv'
  /** When format is tsv, treat the first line as a header row (default true). */
  tsvHasHeader?: boolean
  /**
   * Explicit TSV column names when the response has no header, or to override header names.
   * Mapped to row object keys in order.
   */
  tsvColumns?: string[]
}

export interface DbRestJsonDomainConfig {
  request: DbRestJsonRequestMapping
  response?: DbRestJsonResponseMapping
}

export interface DbSparqlDomainConfig {
  query: string
  prefixes?: Record<string, string>
}

export type DbOntologyOperation = 'lookup' | 'search' | 'children' | 'parents' | 'ancestors'

export interface DbOntologyDomainConfig {
  /** OLS ontology short id, for example go, hp, doid, mesh. */
  ontologyId: string
  operation: DbOntologyOperation
  /** Optional OBO prefix used to build IRIs from compact ids (GO, HP, DOID, MESH). */
  idPrefix?: string
  /** Optional IRI prefix template; `{local_id}` is replaced with underscore form such as GO_0006915. */
  iriTemplate?: string
}

export interface DbRecordIdentity {
  stableIdFields: string[]
  namespace?: string
  primaryUrlTemplate?: string
}

export interface DbDomainManifest {
  id: string
  dbParam?: string
  summary: string
  commonFields: string[]
  fields?: DbFieldSchema[]
  identity?: DbRecordIdentity
  rest?: DbRestJsonDomainConfig
  sparql?: DbSparqlDomainConfig
  ontology?: DbOntologyDomainConfig
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

export interface DbConnectorAuthSettings {
  type: DbConnectorAuth['type']
  envVar?: string
  required: boolean
  label?: string
  signupUrl?: string
  configured: boolean
  configuredFromEnv: boolean
  configuredInStore: boolean
  /** True when OS safeStorage encryption is available for settings-backed secrets. */
  storageAvailable: boolean
}

export interface DbConnectorSettingsItem {
  id: string
  name: string
  protocolFamily: DbProtocolFamily
  curationTier: DbCurationTier
  trustTier: DbTrustTier
  enabledForQuery: boolean
  installedAt: string
  domainCount: number
  domains: Array<{ id: string; summary: string }>
  auth?: DbConnectorAuthSettings
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
  pagesFetched?: number
}

export interface DbAdapterQueryResult {
  rows: Record<string, unknown>[]
  totalRows?: number
  truncated: boolean
  nextCursor?: string
  provenance: DbQueryProvenance
}

export type DbDownloadFileAvailability =
  'candidate_file' | 'directory' | 'direct_url' | 'landing_page'

export type DbDownloadFileSource =
  | 'derived_from_gse_accession'
  | 'sra_efetch_xml'
  | 'derived_from_run_accession'
  | 'derived_from_uniprot_accession'
  | (string & {})

export interface DbDownloadFileCandidate {
  kind: string
  url: string
  accession?: string
  label?: string
  format?: string
  compression?: string
  filename?: string
  size?: number
  md5?: string
  semantic_name?: string
  supertype?: string
  cluster?: string
  availability: DbDownloadFileAvailability
  source: DbDownloadFileSource
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
  format: 'jsonl' | 'csv' | 'metadata_json' | 'download_manifest_json'
  bytes: number
  rowCount?: number
  sha256?: string
}

export interface DbDownloadManifestSummary {
  rowCount: number
  candidateCount: number
  directUrlCount: number
  landingPageCount: number
  directoryCount: number
  candidateFileCount: number
  formats: string[]
  kinds: string[]
}

export interface DbDownloadPlan {
  status: 'ready' | 'needs_verification'
  directUrlCount: number
  toolName: 'db_download'
  toolArgs: {
    manifestPath: string
    maxFiles: number
  }
  suggestedOutputDir: string
  notes: string[]
}

export interface DbDownloadedFile {
  rowIndex: number
  accession?: string
  kind?: string
  url: string
  sourcePath: string
  path: string
  filename: string
  bytes: number
  sha256: string
}

export interface DbDownloadSkippedFile {
  rowIndex?: number
  accession?: string
  kind?: string
  url?: string
  reason: string
}

export interface DbDownloadToolDetails {
  kind: 'db_download_result'
  status: 'complete' | 'partial' | 'empty' | 'failed'
  manifestPath: string
  outputDir: string
  requestedCount: number
  downloadedCount: number
  skippedCount: number
  failedCount: number
  files: DbDownloadedFile[]
  skipped: DbDownloadSkippedFile[]
  failures: DbDownloadSkippedFile[]
}

export type DbResultViewerKind = 'protein_structure' | 'small_molecule' | 'interaction_network'

export type DbResultViewerLibrary = 'molstar' | 'rdkit-js' | 'cytoscape-js'

export interface DbResultViewerHint {
  kind: DbResultViewerKind
  label: string
  recommendedLibrary: DbResultViewerLibrary
  confidence: 'low' | 'medium' | 'high'
  rowCount: number
  fields: string[]
  sampleValues: string[]
  reason: string
}

export type DbQueryToolDetails =
  | {
      kind: 'db_query_result'
      mode: 'inline'
      summary: DbResultSummary
      rows: Record<string, unknown>[]
      viewerHints?: DbResultViewerHint[]
      artifacts?: DbQueryArtifact[]
      downloadManifestArtifact?: DbQueryArtifact
      downloadManifestSummary?: DbDownloadManifestSummary
      downloadInstructions?: string[]
      downloadPlan?: DbDownloadPlan
      provenance: DbQueryProvenance
      resolvedQuery?: DbResolvedQuery
    }
  | {
      kind: 'db_query_result'
      mode: 'artifact'
      summary: DbResultSummary
      sampleRows: Record<string, unknown>[]
      viewerHints?: DbResultViewerHint[]
      artifact: DbQueryArtifact
      artifacts: DbQueryArtifact[]
      metadataArtifact: DbQueryArtifact
      csvArtifact?: DbQueryArtifact
      downloadManifestArtifact?: DbQueryArtifact
      downloadManifestSummary?: DbDownloadManifestSummary
      downloadInstructions?: string[]
      downloadPlan?: DbDownloadPlan
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
