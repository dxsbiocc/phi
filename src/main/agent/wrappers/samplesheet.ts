import { basename } from 'node:path'

/**
 * FASTQ glob input is a convenience layer the runtime resolves into a
 * samplesheet (see technical design's "Input And Output Types"). This
 * recognizes the common `_R1`/`_R2` (or `_1`/`_2`) mate-pair naming
 * convention and derives the sample name by stripping that marker and
 * everything after it.
 */
const MATE_PATTERN = /^(.*?)[._-](R?[12])(?:[._-].*)?\.(?:fastq|fq)(?:\.gz)?$/i
const LANE_SUFFIX = /^(.*?)[._-](L\d{1,3})$/i

export interface SamplesheetRow {
  sample: string
  fastq_1: string
  fastq_2?: string
}

export interface SamplesheetBuildOptions {
  /** Require both R1 and R2 for every sample. Defaults to `true` for paired-end sheets. */
  requirePairedEnd?: boolean
  /**
   * When `false` (default), multiple distinct lanes for the same base sample
   * (e.g. `S1_L001` and `S1_L002`) are rejected instead of being emitted as
   * separate samples (which would cause downstream pseudoreplication).
   */
  allowMultiLaneAsSeparateSamples?: boolean
}

export interface SamplesheetBuildResult {
  rows: SamplesheetRow[]
  /** CSV text ready to persist alongside the plan (see technical design's Storage). */
  csv: string
  errors: string[]
}

/**
 * RFC4180-style CSV field quoting. Values here are resolved file paths —
 * commas in a path (rare, but real: a project directory literally named
 * with one) would otherwise silently shift every later column in the row,
 * corrupting the samplesheet Nextflow reads without any visible error.
 */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function mateNumber(marker: string): 1 | 2 | undefined {
  const digits = marker.replace(/[^12]/g, '')
  if (digits === '1') return 1
  if (digits === '2') return 2
  return undefined
}

interface SampleEntry {
  fastq_1?: string
  fastq_2?: string
  conflicted?: boolean
}

function registerFastqPath(
  path: string,
  bySample: Map<string, SampleEntry>,
  lanesByBaseSample: Map<string, Map<string, string>>,
  errors: string[]
): void {
  const fileName = basename(path)
  const match = MATE_PATTERN.exec(fileName)
  if (!match) {
    errors.push(`Cannot identify sample/mate information from filename: ${fileName}`)
    return
  }
  const [, sampleRaw, marker] = match
  const mate = mateNumber(marker)
  if (!mate) {
    errors.push(`Cannot identify mate number: ${fileName}`)
    return
  }
  const sample = sampleRaw.replace(/[._-]+$/, '').trim()
  if (!sample) {
    errors.push(`Cannot identify sample name from filename: ${fileName}`)
    return
  }

  const entry = bySample.get(sample) ?? {}
  const key = mate === 1 ? 'fastq_1' : 'fastq_2'
  const label = mate === 1 ? 'R1' : 'R2'
  if (entry[key] !== undefined) {
    entry.conflicted = true
    errors.push(
      `Duplicate ${label} file for sample "${sample}": "${entry[key]}" conflicts with "${path}"`
    )
  } else {
    entry[key] = path
  }
  bySample.set(sample, entry)

  const laneMatch = LANE_SUFFIX.exec(sample)
  if (!laneMatch) return
  const baseSample = laneMatch[1].replace(/[._-]+$/, '').trim()
  if (!baseSample) return
  const lanes = lanesByBaseSample.get(baseSample) ?? new Map<string, string>()
  lanes.set(laneMatch[2].toUpperCase(), sample)
  lanesByBaseSample.set(baseSample, lanes)
}

function collectMultiLaneConflicts(
  lanesByBaseSample: Map<string, Map<string, string>>,
  errors: string[]
): Set<string> {
  const multiLaneSamples = new Set<string>()
  for (const [baseSample, lanes] of [...lanesByBaseSample.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (lanes.size <= 1) continue
    const laneList = [...lanes.keys()].sort().join(', ')
    errors.push(
      `Multiple lanes detected for sample "${baseSample}" (${laneList}): merge lanes or supply an explicit samplesheet instead of treating lanes as separate samples`
    )
    for (const sampleKey of lanes.values()) multiLaneSamples.add(sampleKey)
  }
  return multiLaneSamples
}

/** Builds a paired-end FASTQ samplesheet from resolved local paths with integrity checks. */
export function buildPairedEndFastqSamplesheet(
  paths: string[],
  columns: string[] = ['sample', 'fastq_1', 'fastq_2'],
  options: SamplesheetBuildOptions = {}
): SamplesheetBuildResult {
  const requirePairedEnd = options.requirePairedEnd ?? true
  const allowMultiLaneAsSeparateSamples = options.allowMultiLaneAsSeparateSamples ?? false
  const bySample = new Map<string, SampleEntry>()
  const lanesByBaseSample = new Map<string, Map<string, string>>()
  const errors: string[] = []

  if (paths.length === 0) errors.push('No FASTQ files provided for samplesheet')
  for (const path of paths) registerFastqPath(path, bySample, lanesByBaseSample, errors)

  const multiLaneSamples = allowMultiLaneAsSeparateSamples
    ? new Set<string>()
    : collectMultiLaneConflicts(lanesByBaseSample, errors)

  const rows: SamplesheetRow[] = []
  for (const [sample, entry] of [...bySample.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.conflicted || multiLaneSamples.has(sample)) continue
    if (!entry.fastq_1) {
      errors.push(`Sample "${sample}" has no R1 file`)
      continue
    }
    if (requirePairedEnd && !entry.fastq_2) {
      errors.push(`Sample "${sample}" has no R2 file`)
      continue
    }
    rows.push({ sample, fastq_1: entry.fastq_1, fastq_2: entry.fastq_2 })
  }

  const header = columns.map(csvField).join(',')
  const lines = rows.map((row) => {
    const record = row as unknown as Record<string, string | undefined>
    return columns.map((column) => csvField(record[column] ?? '')).join(',')
  })
  return { rows, csv: [header, ...lines].join('\n'), errors }
}
