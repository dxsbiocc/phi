import { basename } from 'node:path'

/**
 * FASTQ glob input is a convenience layer the runtime resolves into a
 * samplesheet (see technical design's "Input And Output Types"). This
 * recognizes the common `_R1`/`_R2` (or `_1`/`_2`) mate-pair naming
 * convention and derives the sample name by stripping that marker and
 * everything after it.
 */
const MATE_PATTERN = /^(.*?)[._-](R?[12])(?:[._-].*)?\.(?:fastq|fq)(?:\.gz)?$/i

export interface SamplesheetRow {
  sample: string
  fastq_1: string
  fastq_2?: string
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

/** Builds a paired-end FASTQ samplesheet from resolved local paths. */
export function buildPairedEndFastqSamplesheet(
  paths: string[],
  columns: string[] = ['sample', 'fastq_1', 'fastq_2']
): SamplesheetBuildResult {
  const bySample = new Map<string, { fastq_1?: string; fastq_2?: string }>()
  const errors: string[] = []

  for (const path of paths) {
    const match = MATE_PATTERN.exec(basename(path))
    if (!match) {
      errors.push(`无法从文件名识别样本/mate 信息: ${basename(path)}`)
      continue
    }
    const [, sampleRaw, marker] = match
    const mate = mateNumber(marker)
    if (!mate) {
      errors.push(`无法识别 mate 编号: ${basename(path)}`)
      continue
    }
    const sample = sampleRaw.replace(/[._-]$/, '')
    const entry = bySample.get(sample) ?? {}
    if (mate === 1) entry.fastq_1 = path
    else entry.fastq_2 = path
    bySample.set(sample, entry)
  }

  const rows: SamplesheetRow[] = []
  for (const [sample, entry] of [...bySample.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!entry.fastq_1) {
      errors.push(`样本 "${sample}" 缺少 R1 文件`)
      continue
    }
    rows.push({ sample, fastq_1: entry.fastq_1, fastq_2: entry.fastq_2 })
  }

  const header = columns.map(csvField).join(',')
  const lines = rows.map((row) => {
    const record = row as unknown as Record<string, string | undefined>
    return columns.map((column) => csvField(record[column] ?? '')).join(',')
  })
  const csv = [header, ...lines].join('\n')

  return { rows, csv, errors }
}
