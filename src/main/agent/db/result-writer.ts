import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getSessionDir } from '../session/session-store'
import { getDbConnectorResultsDir } from './store'
import type {
  DbAdapterQueryResult,
  DbQueryArtifact,
  DbQueryToolDetails,
  DbResolvedQuery,
  DbResultSummary
} from './manifest-types'

const INLINE_ROW_LIMIT = 25
const INLINE_CHAR_LIMIT = 20_000
const SAMPLE_ROW_LIMIT = 5

interface DbMetadataField {
  name: string
  types: string[]
  nullable: boolean
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

export function buildDbQueryToolDetails(
  result: DbAdapterQueryResult,
  options: {
    agentDir: string
    sessionId?: string
    fileStem?: string
    resolvedQuery?: DbResolvedQuery
  }
): DbQueryToolDetails {
  const summary = summaryFrom(result)
  if (shouldInline(result)) {
    return {
      kind: 'db_query_result',
      mode: 'inline',
      summary,
      rows: result.rows,
      provenance: result.provenance,
      ...(options.resolvedQuery ? { resolvedQuery: options.resolvedQuery } : {})
    }
  }

  const dir = artifactDir(options)
  ensureDir(dir)
  const fileStem = (options.fileStem ?? `${result.provenance.database}-${result.provenance.domain}`)
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80)
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

  const metadata = {
    kind: 'db_query_metadata',
    summary,
    provenance: result.provenance,
    ...(options.resolvedQuery ? { resolvedQuery: options.resolvedQuery } : {}),
    schema: {
      fields: metadataSchema(result.rows, fields)
    },
    artifacts,
    primaryArtifact: artifact
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
    outputPath: jsonlPath,
    outputArtifact: { kind: 'tool_output', path: jsonlPath, bytes },
    provenance: result.provenance,
    ...(options.resolvedQuery ? { resolvedQuery: options.resolvedQuery } : {})
  }
}
