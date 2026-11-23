import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

import type { WrapperStepQcMetrics, WrapperStepQcSummary } from './types'

const MAX_SCAN_DEPTH = 5
const MAX_SCAN_FILES = 200
const MAX_QC_FILE_BYTES = 512 * 1024

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(/%$/, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const FASTQC_NUMERIC_KEYS: Record<string, string> = {
  'Total Sequences': 'totalSequences',
  'Sequences flagged as poor quality': 'poorQualitySequences',
  '%GC': 'gcPercent'
}

function parseFastqcLine(
  line: string,
  metrics: Record<string, number | string>,
  flags: Record<string, 'PASS' | 'WARN' | 'FAIL'>
): string | undefined {
  if (line.startsWith('>>') && line !== '>>END_MODULE') {
    const [name, status] = line.slice(2).split('\t')
    if (name && (status === 'pass' || status === 'warn' || status === 'fail')) {
      flags[name] = status.toUpperCase() as 'PASS' | 'WARN' | 'FAIL'
    }
    return undefined
  }
  const [key, value] = line.split('\t')
  if (!key || value === undefined) return undefined
  if (key === 'Filename') return value.trim()
  if (key === 'Sequence length') {
    metrics.sequenceLength = value.trim()
    return undefined
  }
  const targetKey = FASTQC_NUMERIC_KEYS[key]
  if (targetKey) {
    const n = finiteNumber(value)
    if (n !== undefined) metrics[targetKey] = n
  }
  return undefined
}

export function parseFastqcData(
  text: string,
  sourcePath: string
): WrapperStepQcMetrics | undefined {
  const metrics: Record<string, number | string> = {}
  const flags: Record<string, 'PASS' | 'WARN' | 'FAIL'> = {}
  let sample: string | undefined

  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    sample = parseFastqcLine(line, metrics, flags) ?? sample
  }

  if (Object.keys(metrics).length === 0 && Object.keys(flags).length === 0) return undefined
  return {
    tool: 'fastqc',
    sourcePath,
    ...(sample ? { sample } : {}),
    metrics,
    ...(Object.keys(flags).length > 0 ? { flags } : {})
  }
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function collectFastpMetrics(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  dup: Record<string, unknown> | undefined,
  filtering: Record<string, unknown> | undefined
): Record<string, number | string> {
  const metrics: Record<string, number | string> = {}
  const pairs: Array<[string, unknown]> = [
    ['beforeTotalReads', before?.total_reads],
    ['afterTotalReads', after?.total_reads],
    ['q20Rate', after?.q20_rate ?? before?.q20_rate],
    ['q30Rate', after?.q30_rate ?? before?.q30_rate],
    ['gcContent', after?.gc_content ?? before?.gc_content],
    ['duplicationRate', dup?.rate]
  ]
  for (const [key, value] of pairs) {
    const n = finiteNumber(value)
    if (n !== undefined) metrics[key] = n
  }
  const passed = finiteNumber(filtering?.passed_filter_reads)
  const total = finiteNumber(before?.total_reads)
  if (passed !== undefined && total !== undefined && total > 0) {
    metrics.passedFilterRate = Number((passed / total).toFixed(6))
  }
  return metrics
}

export function parseFastpJson(text: string, sourcePath: string): WrapperStepQcMetrics | undefined {
  const root = parseJsonRecord(text)
  const summary = asRecord(root?.summary)
  if (!root || !summary) return undefined
  const metrics = collectFastpMetrics(
    asRecord(summary.before_filtering),
    asRecord(summary.after_filtering),
    asRecord(root.duplication),
    asRecord(root.filtering_result)
  )
  return Object.keys(metrics).length > 0 ? { tool: 'fastp', sourcePath, metrics } : undefined
}

export function parseSalmonMetaInfo(
  text: string,
  sourcePath: string
): WrapperStepQcMetrics | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const root = parsed as Record<string, unknown>
  if (typeof root.salmon_version !== 'string' && typeof root.percent_mapped !== 'number') {
    return undefined
  }
  const metrics: Record<string, number | string> = {}
  const numProcessed = finiteNumber(root.num_processed)
  const numMapped = finiteNumber(root.num_mapped)
  const percentMapped = finiteNumber(root.percent_mapped)
  if (numProcessed !== undefined) metrics.numProcessed = numProcessed
  if (numMapped !== undefined) metrics.numMapped = numMapped
  if (percentMapped !== undefined) metrics.percentMapped = percentMapped
  if (typeof root.salmon_version === 'string') metrics.salmonVersion = root.salmon_version
  if (Object.keys(metrics).length === 0) return undefined
  return { tool: 'salmon', sourcePath, metrics }
}

export function parseFeatureCountsSummary(
  text: string,
  sourcePath: string
): WrapperStepQcMetrics[] {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2) return []
  const header = lines[0].split('\t')
  if (header[0] !== 'Status' || header.length < 2) return []

  const totals = new Array<number>(header.length - 1).fill(0)
  const assigned = new Array<number>(header.length - 1).fill(0)

  for (const line of lines.slice(1)) {
    const cols = line.split('\t')
    if (cols.length < header.length) continue
    const status = cols[0]
    for (let i = 1; i < header.length; i += 1) {
      const count = finiteNumber(cols[i])
      if (count === undefined) continue
      totals[i - 1] += count
      if (status === 'Assigned') assigned[i - 1] += count
    }
  }

  return header.slice(1).flatMap((sampleName, idx) => {
    const total = totals[idx]
    if (total <= 0) return []
    const assignedCount = assigned[idx]
    return [
      {
        tool: 'featurecounts' as const,
        sourcePath,
        sample: sampleName,
        metrics: {
          assigned: assignedCount,
          total,
          assignedRate: Number((assignedCount / total).toFixed(6))
        }
      }
    ]
  })
}

export function parseStarLogFinal(
  text: string,
  sourcePath: string
): WrapperStepQcMetrics | undefined {
  const metrics: Record<string, number | string> = {}
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const parts = rawLine.split('|')
    if (parts.length !== 2) continue
    const key = parts[0].trim()
    const val = finiteNumber(parts[1])
    if (val === undefined) continue
    if (key === 'Number of input reads') metrics.inputReads = val
    else if (key === 'Uniquely mapped reads number') metrics.uniquelyMappedReads = val
    else if (key === 'Uniquely mapped reads %') metrics.uniquelyMappedPercent = val
    else if (key === '% of reads mapped to multiple loci') metrics.multiMappedPercent = val
  }
  if (Object.keys(metrics).length === 0) return undefined
  return { tool: 'star', sourcePath, metrics }
}

function readBoundedQcText(filePath: string, realRoot: string): string | undefined {
  try {
    const stats = lstatSync(filePath)
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_QC_FILE_BYTES) return undefined
    const real = realpathSync(filePath)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined
    return readFileSync(real, 'utf-8')
  } catch {
    return undefined
  }
}

function extractQcEntriesForFile(fullPath: string, realRoot: string): WrapperStepQcMetrics[] {
  const name = basename(fullPath)
  const rel = relative(realRoot, fullPath).split(sep).join('/')
  if (name === 'fastqc_data.txt') {
    const text = readBoundedQcText(fullPath, realRoot)
    const parsed = text ? parseFastqcData(text, rel) : undefined
    return parsed ? [parsed] : []
  }
  if (/fastp.*\.json$/i.test(name)) {
    const text = readBoundedQcText(fullPath, realRoot)
    const parsed = text ? parseFastpJson(text, rel) : undefined
    return parsed ? [parsed] : []
  }
  if (name === 'meta_info.json') {
    const text = readBoundedQcText(fullPath, realRoot)
    const parsed = text ? parseSalmonMetaInfo(text, rel) : undefined
    return parsed ? [parsed] : []
  }
  if (name.endsWith('.summary')) {
    const text = readBoundedQcText(fullPath, realRoot)
    return text ? parseFeatureCountsSummary(text, rel) : []
  }
  if (name.endsWith('Log.final.out')) {
    const text = readBoundedQcText(fullPath, realRoot)
    const parsed = text ? parseStarLogFinal(text, rel) : undefined
    return parsed ? [parsed] : []
  }
  return []
}

/**
 * Scans a local run output directory (bounded depth/file-count, symlink-safe)
 * and extracts structured QC metrics from FastQC, fastp, Salmon, featureCounts,
 * and STAR outputs.
 */
export function collectStructuredQcMetrics(rootDir: string): WrapperStepQcSummary | undefined {
  if (!rootDir || !existsSync(rootDir)) return undefined
  let realRoot: string
  try {
    realRoot = realpathSync(resolve(rootDir))
  } catch {
    return undefined
  }

  const entries: WrapperStepQcMetrics[] = []
  let inspectedFiles = 0

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || inspectedFiles >= MAX_SCAN_FILES) return
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (inspectedFiles >= MAX_SCAN_FILES) break
      const fullPath = join(dir, item.name)
      if (item.isSymbolicLink()) continue
      if (item.isDirectory()) {
        walk(fullPath, depth + 1)
        continue
      }
      if (!item.isFile()) continue
      inspectedFiles += 1
      entries.push(...extractQcEntriesForFile(fullPath, realRoot))
    }
  }

  walk(realRoot, 0)
  if (entries.length === 0) return undefined
  return { capturedAt: new Date().toISOString(), entries }
}
