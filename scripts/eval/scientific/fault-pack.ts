import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { observedValue } from '../../../src/shared/scientificContextTypes'
import {
  computeArtifactSha256,
  scientificContextSidecarPath,
  writeScientificContextSidecar
} from '../../../src/main/agent/scientific-context/sidecar'

/**
 * Reproducible normal/fault paired scientific benchmark task pack (R18).
 *
 * Covers the 4 canonical silent-failure fault modes plus explicit tagging of
 * unobservable faults (e.g. hidden sample-label swaps) that are NOT presumed detectable
 * from inputs alone:
 *   1. `truncated_table` — truncates a tabular artifact mid-row/mid-file
 *   2. `duplicate_mate` — injects a colliding second R1 FASTQ for an existing sample
 *   3. `reference_mismatch` — writes a conflicting reference assembly (e.g. GRCm39 vs GRCh38)
 *   4. `matrix_semantics_mismatch` — marks a count matrix as `log_transformed` instead of `raw_counts`
 *   5. `unobservable_label_swap` — explicitly tagged `detectableFromInput: false`
 *
 * Every injection verifies its post-condition (`afterSha256 !== beforeSha256` or target created);
 * failed injections are marked `invalid_trial` and never counted as valid fault trials.
 */

export type FaultKind =
  | 'truncated_table'
  | 'duplicate_mate'
  | 'reference_mismatch'
  | 'matrix_semantics_mismatch'
  | 'unobservable_label_swap'

export interface FaultInjectionRecipe {
  variantId: string
  faultKind: FaultKind
  seed: number
  sourcePath: string
  operation: string
  /** False for faults that cannot be detected purely from input inspection (e.g. hidden label swap). */
  detectableFromInput: boolean
  beforeSha256?: string
  afterSha256?: string
  injectionStatus: 'verified' | 'invalid_trial'
  notes?: string
}

export interface FaultOutcomeRecord {
  pairId: string
  isFaultVariant: boolean
  detectableFromInput: boolean
  injectionStatus: 'verified' | 'invalid_trial'
  outcome: 'passed' | 'rejected' | 'continued_silently' | 'false_block' | 'unknown_paused'
}

export interface FaultPackSummary {
  normalPassed: number
  falseBlockOnNormal: number
  faultRejected: number
  faultContinuedSilently: number
  unknownPaused: number
  invalidInjectionTrials: number
  unobservableFaultsTotal: number
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function injectFaultVariant(input: {
  variantId: string
  faultKind: FaultKind
  seed: number
  targetPath: string
  /** Optional conflicting assembly for `reference_mismatch` (default `GRCm39`). */
  conflictingAssembly?: string
}): FaultInjectionRecipe {
  const { variantId, faultKind, seed, targetPath } = input
  const detectableFromInput = faultKind !== 'unobservable_label_swap'

  if (!existsSync(targetPath)) {
    return {
      variantId,
      faultKind,
      seed,
      sourcePath: targetPath,
      operation: 'target_missing',
      detectableFromInput,
      injectionStatus: 'invalid_trial',
      notes: `Target file does not exist: ${targetPath}`
    }
  }

  const beforeSha256 = computeArtifactSha256(targetPath)

  if (faultKind === 'truncated_table') {
    const raw = readFileSync(targetPath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.length > 0)
    if (lines.length < 2) {
      return {
        variantId,
        faultKind,
        seed,
        sourcePath: targetPath,
        operation: 'truncate_last_row_columns',
        detectableFromInput,
        beforeSha256,
        injectionStatus: 'invalid_trial',
        notes: 'Table has fewer than 2 lines; cannot inject truncation fault'
      }
    }
    const lastCols = lines[lines.length - 1].split('\t')
    const truncatedLast = lastCols.slice(0, Math.max(1, lastCols.length - 1)).join('\t')
    const nextText = [...lines.slice(0, -1), truncatedLast].join('\n') + '\n'
    writeFileSync(targetPath, nextText, 'utf-8')
    const afterSha256 = computeArtifactSha256(targetPath)
    return {
      variantId,
      faultKind,
      seed,
      sourcePath: targetPath,
      operation: 'truncate_last_row_columns',
      detectableFromInput,
      beforeSha256,
      afterSha256,
      injectionStatus: afterSha256 && afterSha256 !== beforeSha256 ? 'verified' : 'invalid_trial'
    }
  }

  if (faultKind === 'duplicate_mate') {
    const dupDir = join(dirname(targetPath), `dup_batch_${seed}`)
    mkdirSync(dupDir, { recursive: true })
    const dupPath = join(dupDir, basename(targetPath))
    copyFileSync(targetPath, dupPath)
    const afterSha256 = computeArtifactSha256(dupPath)
    return {
      variantId,
      faultKind,
      seed,
      sourcePath: dupPath,
      operation: `copy_duplicate_mate:${basename(targetPath)}`,
      detectableFromInput,
      beforeSha256,
      afterSha256,
      injectionStatus: existsSync(dupPath) ? 'verified' : 'invalid_trial'
    }
  }

  if (faultKind === 'reference_mismatch') {
    const assembly = input.conflictingAssembly ?? 'GRCm39'
    const sidecarPath = scientificContextSidecarPath(targetPath)
    const beforeSidecar = existsSync(sidecarPath) ? readFileSync(sidecarPath, 'utf-8') : ''
    writeScientificContextSidecar(targetPath, {
      producer: { kind: 'wrapper', id: 'fault-injector' },
      location: 'local',
      path: targetPath,
      hashLocalBytes: true,
      reference: observedValue({ assembly }, `fault:${variantId}`),
      matrix: observedValue({ valueSemantics: 'raw_counts' }, `fault:${variantId}`)
    })
    const afterSidecar = readFileSync(sidecarPath, 'utf-8')
    return {
      variantId,
      faultKind,
      seed,
      sourcePath: sidecarPath,
      operation: `set_reference_assembly:${assembly}`,
      detectableFromInput,
      beforeSha256: beforeSidecar ? sha256Text(beforeSidecar) : undefined,
      afterSha256: sha256Text(afterSidecar),
      injectionStatus: afterSidecar !== beforeSidecar ? 'verified' : 'invalid_trial'
    }
  }

  if (faultKind === 'matrix_semantics_mismatch') {
    const sidecarPath = scientificContextSidecarPath(targetPath)
    const beforeSidecar = existsSync(sidecarPath) ? readFileSync(sidecarPath, 'utf-8') : ''
    writeScientificContextSidecar(targetPath, {
      producer: { kind: 'notebook', id: 'fault-injector' },
      location: 'local',
      path: targetPath,
      hashLocalBytes: true,
      reference: observedValue({ assembly: 'GRCh38.p14' }, `fault:${variantId}`),
      matrix: observedValue({ valueSemantics: 'log_transformed' }, `fault:${variantId}`)
    })
    const afterSidecar = readFileSync(sidecarPath, 'utf-8')
    return {
      variantId,
      faultKind,
      seed,
      sourcePath: sidecarPath,
      operation: 'set_matrix_semantics:log_transformed',
      detectableFromInput,
      beforeSha256: beforeSidecar ? sha256Text(beforeSidecar) : undefined,
      afterSha256: sha256Text(afterSidecar),
      injectionStatus: afterSidecar !== beforeSidecar ? 'verified' : 'invalid_trial'
    }
  }

  // unobservable_label_swap: explicitly recorded as undetectable from input alone.
  return {
    variantId,
    faultKind,
    seed,
    sourcePath: targetPath,
    operation: 'mark_unobservable_label_swap',
    detectableFromInput: false,
    beforeSha256,
    afterSha256: beforeSha256,
    injectionStatus: 'verified',
    notes: 'Unobservable label swap is retained as a negative control and never presumed detectable from input'
  }
}

export function summarizeFaultPackOutcomes(records: readonly FaultOutcomeRecord[]): FaultPackSummary {
  const summary: FaultPackSummary = {
    normalPassed: 0,
    falseBlockOnNormal: 0,
    faultRejected: 0,
    faultContinuedSilently: 0,
    unknownPaused: 0,
    invalidInjectionTrials: 0,
    unobservableFaultsTotal: 0
  }

  for (const record of records) {
    if (record.injectionStatus === 'invalid_trial') {
      summary.invalidInjectionTrials += 1
      continue
    }
    if (record.isFaultVariant && !record.detectableFromInput) {
      summary.unobservableFaultsTotal += 1
      continue
    }
    if (!record.isFaultVariant) {
      if (record.outcome === 'passed') summary.normalPassed += 1
      else if (record.outcome === 'false_block' || record.outcome === 'rejected') {
        summary.falseBlockOnNormal += 1
      } else if (record.outcome === 'unknown_paused') {
        summary.unknownPaused += 1
      }
      continue
    }
    if (record.outcome === 'rejected') summary.faultRejected += 1
    else if (record.outcome === 'continued_silently') summary.faultContinuedSilently += 1
    else if (record.outcome === 'unknown_paused') summary.unknownPaused += 1
  }

  return summary
}
