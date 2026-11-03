import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface JsonlParseIssue {
  lineNumber: number
  reason: 'invalid-json' | 'non-object'
}

export interface JsonlRecord {
  lineNumber: number
  value: Record<string, unknown>
}

export interface JsonlParseResult {
  records: JsonlRecord[]
  issues: JsonlParseIssue[]
}

export interface AppLogEntry extends Record<string, unknown> {
  event: string
  timestamp?: string
  sessionId?: string
  runId?: string
  metadata?: Record<string, unknown>
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Parse JSONL without echoing malformed input, which may contain credentials. */
export function parseJsonl(source: string): JsonlParseResult {
  const records: JsonlRecord[] = []
  const issues: JsonlParseIssue[] = []
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      const value = objectRecord(JSON.parse(line))
      if (value) records.push({ lineNumber: index + 1, value })
      else issues.push({ lineNumber: index + 1, reason: 'non-object' })
    } catch {
      issues.push({ lineNumber: index + 1, reason: 'invalid-json' })
    }
  }
  return { records, issues }
}

export function readJsonlFile(path: string): JsonlParseResult {
  if (!existsSync(path)) return { records: [], issues: [] }
  return parseJsonl(readFileSync(path, 'utf8'))
}

function appLogEntry(value: Record<string, unknown>): AppLogEntry | undefined {
  if (typeof value.event !== 'string' || !value.event) return undefined
  const metadata = objectRecord(value.metadata)
  return {
    ...value,
    event: value.event,
    ...(typeof value.timestamp === 'string' ? { timestamp: value.timestamp } : {}),
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
    ...(metadata ? { metadata } : {})
  }
}

export function parseAppLogJsonl(source: string): {
  entries: AppLogEntry[]
  issues: JsonlParseIssue[]
} {
  const parsed = parseJsonl(source)
  const entries = parsed.records.flatMap(({ value }): AppLogEntry[] => {
    const entry = appLogEntry(value)
    return entry ? [entry] : []
  })
  return { entries, issues: parsed.issues }
}

export function readAppLogDirectory(logDir: string): {
  entries: AppLogEntry[]
  issues: Array<JsonlParseIssue & { fileName: string }>
} {
  if (!existsSync(logDir)) return { entries: [], issues: [] }
  const entries: AppLogEntry[] = []
  const issues: Array<JsonlParseIssue & { fileName: string }> = []
  const fileNames = readdirSync(logDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
  for (const fileName of fileNames) {
    const parsed = parseAppLogJsonl(readFileSync(join(logDir, fileName), 'utf8'))
    entries.push(...parsed.entries)
    issues.push(...parsed.issues.map((issue) => ({ ...issue, fileName })))
  }
  return { entries, issues }
}

export function logEntriesSince(entries: AppLogEntry[], timestamp: string): AppLogEntry[] {
  const cutoff = Date.parse(timestamp)
  if (!Number.isFinite(cutoff)) return []
  return entries.filter((entry) => {
    const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    return Number.isFinite(time) && time >= cutoff
  })
}
