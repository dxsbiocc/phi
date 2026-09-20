import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getSessionDir } from '../session/session-store'
import { getDbConnectorResultsDir } from './store'
import type {
  DbAdapterQueryResult,
  DbDownloadFileAvailability,
  DbDownloadFileCandidate,
  DbDownloadManifestSummary,
  DbQueryArtifact,
  DbQueryToolDetails,
  DbResolvedQuery,
  DbResultSummary
} from './manifest-types'

const INLINE_ROW_LIMIT = 25
const INLINE_CHAR_LIMIT = 20_000
const SAMPLE_ROW_LIMIT = 5
const DOWNLOAD_FILE_AVAILABILITIES = new Set<DbDownloadFileAvailability>([
  'candidate_file',
  'directory',
  'direct_url',
  'landing_page'
])

interface DbMetadataField {
  name: string
  types: string[]
  nullable: boolean
}

interface BuildDbQueryToolDetailsOptions {
  agentDir: string
  sessionId?: string
  fileStem?: string
  resolvedQuery?: DbResolvedQuery
}

interface DownloadManifestRow {
  rowIndex: number
  uid?: string
  accession?: string
  title?: string
  download_files: DbDownloadFileCandidate[]
  download_urls?: unknown
}

interface DownloadManifest {
  kind: 'db_query_download_manifest'
  generatedAt: string
  summary: DbResultSummary
  provenance: DbAdapterQueryResult['provenance']
  resolvedQuery?: DbResolvedQuery
  rows: DownloadManifestRow[]
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8')
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function rowsAreFlat(rows: Record<string, unknown>[]): boolean {
  return rows.every((row) => Object.values(row).every(isScalar))
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function rowsToCsv(rows: Record<string, unknown>[], fields: string[]): string {
  return [
    fields.map(csvEscape).join(','),
    ...rows.map((row) => fields.map((field) => csvEscape(row[field])).join(','))
  ].join('\n')
}

function resultFields(rows: Record<string, unknown>[]): string[] {
  const fields = new Set<string>()
  for (const row of rows) {
    for (const field of Object.keys(row)) fields.add(field)
  }
  return [...fields]
}

function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function metadataSchema(rows: Record<string, unknown>[], fields: string[]): DbMetadataField[] {
  return fields.map((field) => {
    const types = new Set<string>()
    let nullable = false
    for (const row of rows) {
      if (!(field in row) || row[field] === null || row[field] === undefined) nullable = true
      if (field in row && row[field] !== undefined) types.add(valueType(row[field]))
    }
    return {
      name: field,
      types: [...types].sort(),
      nullable
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDbDownloadFileCandidate(value: unknown): value is DbDownloadFileCandidate {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    value.kind.length > 0 &&
    typeof value.url === 'string' &&
    value.url.length > 0 &&
    typeof value.availability === 'string' &&
    DOWNLOAD_FILE_AVAILABILITIES.has(value.availability as DbDownloadFileAvailability) &&
    typeof value.source === 'string' &&
    value.source.length > 0
  )
}

function stringField(row: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = row[field]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

function downloadFileCandidates(value: unknown): DbDownloadFileCandidate[] {
  if (!Array.isArray(value)) return []
  return value.filter(isDbDownloadFileCandidate).map((candidate) => ({ ...candidate }))
}

function summaryFrom(result: DbAdapterQueryResult): DbResultSummary {
  return {
    rowCount: result.totalRows ?? result.rows.length,
    returnedRows: result.rows.length,
    truncated: result.truncated,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    fields: resultFields(result.rows),
    warnings: []
  }
}

function shouldInline(result: DbAdapterQueryResult): boolean {
  const serialized = JSON.stringify(result.rows)
  return (
    result.rows.length <= INLINE_ROW_LIMIT &&
    serialized.length <= INLINE_CHAR_LIMIT &&
    !serialized.match(/[A-Za-z]{2000,}/)
  )
}

function artifactDir(options: { agentDir: string; sessionId?: string }): string {
  if (options.sessionId) return join(getSessionDir(options.sessionId), 'artifacts', 'db')
  return getDbConnectorResultsDir(options.agentDir)
}

function safeFileStem(
  result: DbAdapterQueryResult,
  options: BuildDbQueryToolDetailsOptions
): string {
  const stem = (options.fileStem ?? `${result.provenance.database}-${result.provenance.domain}`)
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80)
  return stem.length > 0 ? stem : 'db-query-result'
}

function buildDownloadManifest(
  result: DbAdapterQueryResult,
  summary: DbResultSummary,
  resolvedQuery?: DbResolvedQuery
): DownloadManifest | undefined {
  const rows: DownloadManifestRow[] = []
  result.rows.forEach((row, rowIndex) => {
    const downloadFiles = downloadFileCandidates(row['download_files'])
    if (downloadFiles.length === 0) return
    const uid = stringField(row, ['uid', 'id'])
    const accession = stringField(row, ['accession', 'geo_accession', 'series_accession', 'gse'])
    const title = stringField(row, ['title'])
    rows.push({
      rowIndex,
      ...(uid ? { uid } : {}),
      ...(accession ? { accession } : {}),
      ...(title ? { title } : {}),
      download_files: downloadFiles,
      ...(row['download_urls'] !== undefined ? { download_urls: row['download_urls'] } : {})
    })
  })

  if (rows.length === 0) return undefined

  return {
    kind: 'db_query_download_manifest',
    generatedAt: result.provenance.retrievedAt,
    summary,
    provenance: result.provenance,
    ...(resolvedQuery ? { resolvedQuery } : {}),
    rows
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function summarizeDownloadManifest(manifest: DownloadManifest): DbDownloadManifestSummary {
  const formats = new Set<string>()
  const kinds = new Set<string>()
  const summary: DbDownloadManifestSummary = {
    rowCount: manifest.rows.length,
    candidateCount: 0,
    directUrlCount: 0,
    landingPageCount: 0,
    directoryCount: 0,
    candidateFileCount: 0,
    formats: [],
    kinds: []
  }

  for (const row of manifest.rows) {
    for (const candidate of row.download_files) {
      summary.candidateCount += 1
      const format = optionalString(candidate.format)
      const kind = optionalString(candidate.kind)
      if (format) formats.add(format)
      if (kind) kinds.add(kind)

      switch (candidate.availability) {
        case 'direct_url':
          summary.directUrlCount += 1
          break
        case 'landing_page':
          summary.landingPageCount += 1
          break
        case 'directory':
          summary.directoryCount += 1
          break
        case 'candidate_file':
          summary.candidateFileCount += 1
          break
      }
    }
  }

  summary.formats = [...formats].sort()
  summary.kinds = [...kinds].sort()
  return summary
}

function writeDownloadManifestArtifact(
  dir: string,
  fileStem: string,
  manifest: DownloadManifest,
  nameHashPrefix?: string
): DbQueryArtifact {
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestHash = createHash('sha256').update(manifestJson).digest('hex')
  const manifestPath = join(
    dir,
    `${fileStem}-${nameHashPrefix ?? manifestHash.slice(0, 12)}.download-manifest.json`
  )
  writeFileSync(manifestPath, manifestJson, 'utf-8')
  return {
    kind: 'db_query_result',
    path: manifestPath,
    format: 'download_manifest_json',
    bytes: byteLength(manifestJson),
    rowCount: manifest.rows.length,
    sha256: `sha256:${manifestHash}`
  }
}

export function buildDbQueryToolDetails(
  result: DbAdapterQueryResult,
  options: BuildDbQueryToolDetailsOptions
): DbQueryToolDetails {
  const summary = summaryFrom(result)
  const downloadManifest = buildDownloadManifest(result, summary, options.resolvedQuery)
  const downloadManifestSummary = downloadManifest
    ? summarizeDownloadManifest(downloadManifest)
    : undefined
  if (shouldInline(result)) {
    let downloadManifestArtifact: DbQueryArtifact | undefined
    if (downloadManifest) {
      const dir = artifactDir(options)
      ensureDir(dir)
      downloadManifestArtifact = writeDownloadManifestArtifact(
        dir,
        safeFileStem(result, options),
        downloadManifest
      )
    }
    return {
      kind: 'db_query_result',
      mode: 'inline',
      summary,
      rows: result.rows,
      ...(downloadManifestArtifact
        ? {
            artifacts: [downloadManifestArtifact],
            downloadManifestArtifact,
            downloadManifestSummary
          }
        : {}),
      provenance: result.provenance,
      ...(options.resolvedQuery ? { resolvedQuery: options.resolvedQuery } : {})
    }
  }

  const dir = artifactDir(options)
  ensureDir(dir)
  const fileStem = safeFileStem(result, options)
  const jsonl = result.rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  const hash = createHash('sha256').update(jsonl).digest('hex')
  const jsonlPath = join(dir, `${fileStem}-${hash.slice(0, 12)}.jsonl`)
  writeFileSync(jsonlPath, jsonl, 'utf-8')

  const fields = resultFields(result.rows)
  const artifacts: DbQueryArtifact[] = []
  const bytes = byteLength(jsonl)
  const artifact: DbQueryArtifact = {
    kind: 'db_query_result',
    path: jsonlPath,
    format: 'jsonl',
    bytes,
    rowCount: result.totalRows ?? result.rows.length,
    sha256: `sha256:${hash}`
  }
  artifacts.push(artifact)

  let csvArtifact: DbQueryArtifact | undefined
  if (rowsAreFlat(result.rows)) {
    const csv = rowsToCsv(result.rows, fields)
    const csvHash = createHash('sha256').update(csv).digest('hex')
    const csvPath = join(dir, `${fileStem}-${hash.slice(0, 12)}.csv`)
    writeFileSync(csvPath, csv, 'utf-8')
    csvArtifact = {
      kind: 'db_query_result',
      path: csvPath,
      format: 'csv',
      bytes: byteLength(csv),
      rowCount: result.totalRows ?? result.rows.length,
      sha256: `sha256:${csvHash}`
    }
    artifacts.push(csvArtifact)
  }

  let downloadManifestArtifact: DbQueryArtifact | undefined
  if (downloadManifest) {
    downloadManifestArtifact = writeDownloadManifestArtifact(
      dir,
      fileStem,
      downloadManifest,
      hash.slice(0, 12)
    )
    artifacts.push(downloadManifestArtifact)
  }

  const metadata = {
    kind: 'db_query_metadata',
    summary,
    provenance: result.provenance,
    ...(options.resolvedQuery ? { resolvedQuery: options.resolvedQuery } : {}),
    schema: {
      fields: metadataSchema(result.rows, fields)
    },
    artifacts,
    primaryArtifact: artifact,
    ...(downloadManifestArtifact ? { downloadManifestArtifact, downloadManifestSummary } : {})
  }
  const metadataJson = `${JSON.stringify(metadata, null, 2)}\n`
  const metadataHash = createHash('sha256').update(metadataJson).digest('hex')
  const metadataPath = join(dir, `${fileStem}-${hash.slice(0, 12)}.metadata.json`)
  writeFileSync(metadataPath, metadataJson, 'utf-8')
  const metadataArtifact: DbQueryArtifact = {
    kind: 'db_query_result',
    path: metadataPath,
    format: 'metadata_json',
    bytes: byteLength(metadataJson),
    rowCount: result.totalRows ?? result.rows.length,
    sha256: `sha256:${metadataHash}`
  }
  artifacts.push(metadataArtifact)

  return {
    kind: 'db_query_result',
    mode: 'artifact',
    summary,
    sampleRows: result.rows.slice(0, SAMPLE_ROW_LIMIT),
    artifact,
    artifacts,
    metadataArtifact,
    ...(csvArtifact ? { csvArtifact } : {}),
    ...(downloadManifestArtifact ? { downloadManifestArtifact, downloadManifestSummary } : {}),
    outputPath: jsonlPath,
    outputArtifact: { kind: 'tool_output', path: jsonlPath, bytes },
    provenance: result.provenance,
    ...(options.resolvedQuery ? { resolvedQuery: options.resolvedQuery } : {})
  }
}
