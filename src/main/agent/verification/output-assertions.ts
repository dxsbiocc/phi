import { lstatSync, openSync, readSync, closeSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * Shared bounded, read-only content assertions for both Wrapper outputs (R10)
 * and PlanStep post-execution verification (R12). Never executes user code and
 * never loads arbitrarily large files into memory.
 */

export type StructuredOutputFormat = 'tsv' | 'csv' | 'json'

export interface OutputContentAssertion {
  /** Rejects 0-byte files (and directories with no checkable bytes). Default false unless set. */
  nonEmpty?: boolean
  /** Structural format to validate (`tsv`, `csv`, or `json`). */
  format?: StructuredOutputFormat
  /** Minimum number of non-empty data rows (excluding the header row) for `tsv`/`csv`. */
  minDataRows?: number
  /** Minimum column count in header/data rows for `tsv`/`csv`. */
  minColumns?: number
  /** Column names that must appear in the header row for `tsv`/`csv`. */
  requiredColumns?: readonly string[]
}

export interface OutputAssertionResult {
  ok: boolean
  reason?: string
}

const MAX_INSPECT_BYTES = 1024 * 1024 // 1 MiB bounded read for table/JSON verification

function withinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

function readBoundedUtf8Prefix(
  filePath: string,
  maxBytes: number
): { text: string; truncated: boolean } | { error: string } {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, 64 * 1024))
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false
    for (;;) {
      const remaining = maxBytes + 1 - total
      if (remaining <= 0) break
      const toRead = Math.min(buffer.length, remaining)
      const bytesRead = readSync(fd, buffer, 0, toRead, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) {
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead - (total - maxBytes))))
        truncated = true
        break
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      return { text, truncated }
    } catch {
      return { error: 'file is not valid UTF-8' }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Ignore close errors on read-only handles.
      }
    }
  }
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else if (ch === '"') {
        inQuotes = false
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function splitRow(line: string, format: 'tsv' | 'csv'): string[] {
  return format === 'tsv' ? line.split('\t') : parseCsvLine(line)
}

/**
 * Evaluates a read-only content assertion against a local file path.
 * When `options.rootDir` is provided, refuses paths or symlinks escaping `rootDir`.
 */
export function verifyFileContentAssertion(
  filePath: string,
  assertion: OutputContentAssertion,
  options: { rootDir?: string; maxBytes?: number } = {}
): OutputAssertionResult {
  const absolute = resolve(filePath)
  if (options.rootDir) {
    const root = resolve(options.rootDir)
    if (!withinRoot(absolute, root)) {
      return { ok: false, reason: 'path escapes allowed root directory' }
    }
    try {
      const realRoot = realpathSync(root)
      const stats = lstatSync(absolute)
      if (!stats.isFile()) return { ok: false, reason: 'target is not a regular file' }
      const realTarget = realpathSync(absolute)
      if (!withinRoot(realTarget, realRoot)) {
        return { ok: false, reason: 'path symlink escapes allowed root directory' }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { ok: false, reason: code === 'ENOENT' ? 'file does not exist' : 'file is unreadable' }
    }
  }

  let stats
  try {
    stats = lstatSync(absolute)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, reason: code === 'ENOENT' ? 'file does not exist' : 'file is unreadable' }
  }
  if (!stats.isFile()) {
    return { ok: false, reason: 'target is not a regular file' }
  }
  if (assertion.nonEmpty && stats.size === 0) {
    return { ok: false, reason: 'file is empty (0 bytes)' }
  }

  const needsParse =
    assertion.format !== undefined ||
    assertion.minDataRows !== undefined ||
    assertion.minColumns !== undefined ||
    (assertion.requiredColumns?.length ?? 0) > 0
  if (!needsParse) return { ok: true }

  const maxBytes = options.maxBytes ?? MAX_INSPECT_BYTES
  const read = readBoundedUtf8Prefix(absolute, maxBytes)
  if ('error' in read) return { ok: false, reason: read.error }

  if (assertion.format === 'json') {
    if (read.truncated) {
      return { ok: false, reason: `JSON file exceeds bounded inspection limit (${maxBytes} bytes)` }
    }
    try {
      JSON.parse(read.text)
      return { ok: true }
    } catch {
      return { ok: false, reason: 'file is not valid JSON' }
    }
  }

  const tableFormat: 'tsv' | 'csv' = assertion.format ?? 'tsv'
  const rawLines = read.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (read.truncated && rawLines.length > 1) rawLines.pop()
  const nonEmptyLines = rawLines.filter((line) => line.trim().length > 0)
  if (nonEmptyLines.length === 0) {
    return { ok: false, reason: `${tableFormat.toUpperCase()} file has no header or rows` }
  }

  const header = splitRow(nonEmptyLines[0], tableFormat).map((col) => col.trim())
  if (assertion.minColumns !== undefined && header.length < assertion.minColumns) {
    return {
      ok: false,
      reason: `expected at least ${assertion.minColumns} columns, found ${header.length}`
    }
  }
  if (assertion.requiredColumns?.length) {
    const headerSet = new Set(header)
    const missing = assertion.requiredColumns.filter((column) => !headerSet.has(column))
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `missing required columns: ${missing.join(', ')}`
      }
    }
  }

  const dataRows = nonEmptyLines.slice(1)
  if (assertion.minDataRows !== undefined && dataRows.length < assertion.minDataRows) {
    return {
      ok: false,
      reason: `expected at least ${assertion.minDataRows} data rows, found ${dataRows.length}`
    }
  }
  if (assertion.minColumns !== undefined) {
    for (let index = 0; index < dataRows.length; index += 1) {
      const cols = splitRow(dataRows[index], tableFormat)
      if (cols.length < assertion.minColumns) {
        return {
          ok: false,
          reason: `row ${index + 1} has ${cols.length} columns, expected at least ${assertion.minColumns}`
        }
      }
    }
  }
  return { ok: true }
}
