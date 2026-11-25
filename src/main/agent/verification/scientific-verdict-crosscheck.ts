import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, posix, resolve, sep } from 'node:path'

import { isRecord } from '../../../shared/guards'
import type { PlanSpec, PlanStep, ScientificKeyMetricRecord } from '../../../shared/planRunTypes'
import { extractStructuredScientificPayload } from '../agents/research-handoff'
import { MAX_REMOTE_LOG_RAW_BYTES, readRemoteFileChunk } from '../wrappers/remote-ssh-log'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'

const MAX_METRIC_SOURCE_BYTES = 1024 * 1024 // 1 MiB bounded inspection

export interface BoundedFileSnapshot {
  ok: true
  text: string
  truncated: boolean
}

export type MetricSourceReadResult = BoundedFileSnapshot | { ok: false; reason: string }
export type MetricSourceReader = (relPath: string) => Promise<MetricSourceReadResult>

function withinLocalRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

export function createLocalMetricSourceReader(rootDir: string): MetricSourceReader {
  return async (relPath: string): Promise<MetricSourceReadResult> => {
    if (isAbsolute(relPath) || relPath.split(/[\\/]+/).includes('..')) {
      return { ok: false, reason: 'path escapes project root' }
    }
    try {
      const realRoot = realpathSync(resolve(rootDir))
      const target = resolve(realRoot, relPath)
      if (!withinLocalRoot(target, realRoot)) {
        return { ok: false, reason: 'path escapes project root' }
      }
      const stats = lstatSync(target)
      if (!stats.isFile()) return { ok: false, reason: 'not a regular file' }
      const realTarget = realpathSync(target)
      if (!withinLocalRoot(realTarget, realRoot)) {
        return { ok: false, reason: 'symlink escapes project root' }
      }
      const toRead = Math.min(stats.size, MAX_METRIC_SOURCE_BYTES)
      const buf = Buffer.alloc(toRead)
      const fd = openSync(realTarget, 'r')
      let bytesRead = 0
      try {
        bytesRead = readSync(fd, buf, 0, toRead, 0)
      } finally {
        closeSync(fd)
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead))
      return { ok: true, text, truncated: stats.size > MAX_METRIC_SOURCE_BYTES }
    } catch {
      return { ok: false, reason: 'source file does not exist or is unreadable' }
    }
  }
}

export function createRemoteMetricSourceReader(
  session: RemoteSshSession,
  remoteRootDir: string
): MetricSourceReader {
  return async (relPath: string): Promise<MetricSourceReadResult> => {
    if (relPath.startsWith('/') || relPath.split(/[\\/]+/).includes('..')) {
      return { ok: false, reason: 'path escapes remote project root' }
    }
    const cleanRoot = posix.resolve(remoteRootDir)
    const remotePath = posix.resolve(cleanRoot, relPath)
    const check = await session.exec(
      [
        `root_real=$(realpath ${shellQuote(cleanRoot)} 2>/dev/null) || exit 20`,
        `target_real=$(realpath ${shellQuote(remotePath)} 2>/dev/null) || exit 21`,
        `case "$target_real" in "$root_real"|"$root_real"/*) ;; *) exit 22 ;; esac`,
        `if [ ! -f "$target_real" ]; then exit 23; fi`,
        `printf '%s' "$target_real"`
      ].join('\n')
    )
    if (check.code !== 0) {
      return { ok: false, reason: 'remote source file does not exist or escapes project root' }
    }
    const realTarget = check.stdout.trim()
    const chunks: Buffer[] = []
    let offset = 0
    let totalSize = MAX_METRIC_SOURCE_BYTES + 1
    while (offset < MAX_METRIC_SOURCE_BYTES && offset < totalSize) {
      const limit = Math.min(MAX_REMOTE_LOG_RAW_BYTES, MAX_METRIC_SOURCE_BYTES - offset)
      const chunk = await readRemoteFileChunk(session, realTarget, { offset, maxBytes: limit })
      if (chunk.missing) return { ok: false, reason: 'remote source file missing' }
      totalSize = chunk.size
      if (chunk.bytes.byteLength === 0) break
      chunks.push(chunk.bytes)
      offset = chunk.nextOffset
    }
    const combined = Buffer.concat(chunks)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(combined)
    return { ok: true, text, truncated: totalSize > MAX_METRIC_SOURCE_BYTES }
  }
}

function numbersMatch(claimed: number, actual: number): boolean {
  const diff = Math.abs(claimed - actual)
  const scale = Math.max(1, Math.abs(actual))
  return diff <= 1e-4 * scale
}

function lookupJsonNumber(root: unknown, dotPath: string): number | undefined {
  let current: unknown = root
  for (const segment of dotPath.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined
}

function checkJsonMetric(metric: ScientificKeyMetricRecord, text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return `keyMetric "${metric.name}": "${metric.sourcePath}" is not valid JSON`
  }
  if (!metric.column) return null
  const actual = lookupJsonNumber(parsed, metric.column)
  if (actual === undefined) {
    return `keyMetric "${metric.name}": JSON field "${metric.column}" not found or non-numeric in "${metric.sourcePath}"`
  }
  return numbersMatch(metric.value, actual)
    ? null
    : `keyMetric "${metric.name}" mismatch in "${metric.sourcePath}" (${metric.column}): claimed ${metric.value}, observed ${actual}`
}

function checkSingleDataRowValue(
  metric: ScientificKeyMetricRecord,
  dataLine: string,
  delimiter: string,
  colIdx: number
): string | null {
  const rawVal = dataLine.split(delimiter)[colIdx]?.trim().replace(/^"|"$/g, '') ?? ''
  const num = Number(rawVal)
  if (!Number.isFinite(num)) {
    return `keyMetric "${metric.name}": value "${rawVal}" in "${metric.sourcePath}" (${metric.column}) is not numeric`
  }
  return numbersMatch(metric.value, num)
    ? null
    : `keyMetric "${metric.name}" mismatch in "${metric.sourcePath}" (${metric.column}): claimed ${metric.value}, observed ${num}`
}

function checkMultiRowColumnContains(
  metric: ScientificKeyMetricRecord,
  dataLines: string[],
  delimiter: string,
  colIdx: number
): string | null {
  const matched = dataLines.some((line) => {
    const rawVal = line.split(delimiter)[colIdx]?.trim().replace(/^"|"$/g, '') ?? ''
    const num = Number(rawVal)
    return Number.isFinite(num) && numbersMatch(metric.value, num)
  })
  return matched
    ? null
    : `keyMetric "${metric.name}": claimed value ${metric.value} does not appear in column "${metric.column}" of "${metric.sourcePath}"`
}

function checkTableMetric(
  metric: ScientificKeyMetricRecord,
  snapshot: BoundedFileSnapshot
): string | null {
  const lines = snapshot.text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    return `keyMetric "${metric.name}": table "${metric.sourcePath}" is empty`
  }
  const delimiter = metric.sourcePath.toLowerCase().endsWith('.csv') ? ',' : '\t'
  if (metric.column === '__row_count__') {
    if (snapshot.truncated) return null
    const actualRows = Math.max(0, lines.length - 1)
    return numbersMatch(metric.value, actualRows)
      ? null
      : `keyMetric "${metric.name}" row-count mismatch in "${metric.sourcePath}": claimed ${metric.value}, observed ${actualRows}`
  }
  if (!metric.column) return null
  const headers = lines[0].split(delimiter).map((col) => col.trim().replace(/^"|"$/g, ''))
  const colIdx = headers.indexOf(metric.column)
  if (colIdx < 0) {
    return `keyMetric "${metric.name}": column "${metric.column}" not found in "${metric.sourcePath}"`
  }
  const dataLines = lines.slice(1)
  if (dataLines.length === 1) {
    return checkSingleDataRowValue(metric, dataLines[0], delimiter, colIdx)
  }
  if (snapshot.truncated || dataLines.length === 0) return null
  return checkMultiRowColumnContains(metric, dataLines, delimiter, colIdx)
}

async function verifySingleKeyMetric(
  metric: ScientificKeyMetricRecord,
  readSource: MetricSourceReader
): Promise<string | null> {
  const fetched = await readSource(metric.sourcePath)
  if (!fetched.ok) {
    return `keyMetric "${metric.name}" (${metric.sourcePath}): ${fetched.reason}`
  }
  const lower = metric.sourcePath.toLowerCase()
  if (lower.endsWith('.json')) {
    return fetched.truncated ? null : checkJsonMetric(metric, fetched.text)
  }
  if (lower.endsWith('.tsv') || lower.endsWith('.csv') || lower.endsWith('.txt')) {
    return checkTableMetric(metric, fetched)
  }
  return null
}

/**
 * Verifies structured `hypothesisVerdicts` and `keyMetrics` reported by a step or specialist
 * against the plan's pre-registered hypothesis IDs and actual workspace artifact values.
 */
export async function verifyScientificReportCrossCheck(input: {
  spec?: PlanSpec
  step: PlanStep
  reportText: string | undefined
  readSource: MetricSourceReader
}): Promise<{ ok: boolean; failures: string[] }> {
  const payload = extractStructuredScientificPayload(input.reportText)
  if (!payload) return { ok: true, failures: [] }

  const failures: string[] = []
  if (payload.hypothesisVerdicts && input.spec?.hypotheses) {
    const knownIds = new Set(input.spec.hypotheses.map((h) => h.id))
    for (const item of payload.hypothesisVerdicts) {
      if (!knownIds.has(item.hypothesisId)) {
        failures.push(`hypothesisVerdict references undeclared hypothesisId "${item.hypothesisId}"`)
      }
    }
  }

  for (const metric of payload.keyMetrics ?? []) {
    const err = await verifySingleKeyMetric(metric, input.readSource)
    if (err) failures.push(err)
  }

  return { ok: failures.length === 0, failures }
}
