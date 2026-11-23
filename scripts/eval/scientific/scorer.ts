import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Independent, read-only scientific artifact scorer (R09).
 *
 * Strictly separates three orthogonal axes for every trial:
 *   1. `fileValidity` — did the expected files exist, stay non-empty, and parse cleanly?
 *   2. `scientificScore` — ID-aligned numerical agreement within frozen tolerances (or
 *      proper rejection on negative/fault tasks), with timeouts/run failures kept in the
 *      denominator and internal `scorer_error` tracked separately.
 *   3. `systemClaim` — what the evaluated system itself claimed, enabling exact measurement
 *      of `falseSuccessClaim` ("silent scientific failures").
 *
 * Read-only: never mutates tested artifacts and never echoes hidden reference rows.
 */

export const SCORER_VERSION = '1.0.0'

export interface TabularScoringRule {
  artifactId: string
  /** Workspace-relative path of the candidate artifact. */
  candidatePath: string
  /** Absolute path to the hidden reference artifact outside the trial workspace. */
  referencePath: string
  format: 'tsv' | 'csv'
  idColumn: string
  numericColumns: string[]
  /** Optional signed effect-size column (e.g. `log2FoldChange` or `NES`) for sign agreement. */
  directionColumn?: string
  absTol: number
  relTol: number
  minIdJaccard: number
  minValueMatchRate: number
  minDirectionAgreement?: number
}

export interface ArtifactScoreRecord {
  artifactId: string
  candidatePath: string
  fileValid: boolean
  fileErrors: string[]
  scientificPass: boolean
  score: number
  idJaccard: number
  valueMatchRate: number
  directionAgreement?: number
  matchedIds: number
  referenceIds: number
  candidateIds: number
  notes: string[]
}

export type TrialExecutionOutcome = 'completed' | 'failed' | 'timeout' | 'cancelled'
export type SystemClaim =
  'claimed_success' | 'claimed_failure' | 'rejected_input' | 'timeout' | 'unknown'

export interface TrialScoreReport {
  scorerVersion: string
  taskId: string
  taskVersion: string
  trialId: string
  scoredAt: string
  fileValidity: 'valid' | 'invalid'
  scientificScore: {
    status:
      'passed' | 'failed' | 'rejected_invalid_input' | 'timeout' | 'run_failed' | 'scorer_error'
    /** In [0, 1]; `null` only on `scorer_error`. Timeouts/failures remain in denominator as 0. */
    score: number | null
    artifacts: ArtifactScoreRecord[]
    error?: string
  }
  systemClaim: SystemClaim
  /** True when the system claimed success but independent scientific scoring failed. */
  falseSuccessClaim: boolean
}

function parseCsvRow(line: string): string[] {
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

function splitTableLine(line: string, format: 'tsv' | 'csv'): string[] {
  return format === 'tsv' ? line.split('\t') : parseCsvRow(line)
}

interface ParsedTable {
  header: string[]
  rowsById: Map<string, Record<string, string>>
  duplicateIds: string[]
  rowCount: number
}

function parseTableFile(
  filePath: string,
  format: 'tsv' | 'csv',
  idColumn: string,
  requiredColumns: readonly string[]
): { ok: true; table: ParsedTable } | { ok: false; errors: string[] } {
  if (!existsSync(filePath)) return { ok: false, errors: ['file does not exist'] }
  const stats = lstatSync(filePath)
  if (!stats.isFile()) return { ok: false, errors: ['target is not a regular file'] }
  if (stats.size === 0) return { ok: false, errors: ['file is empty (0 bytes)'] }

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0)
  if (lines.length < 2) {
    return { ok: false, errors: ['table must contain a header and at least one data row'] }
  }

  const header = splitTableLine(lines[0], format).map((col) => col.trim())
  const headerSet = new Set(header)
  const missingCols = [idColumn, ...requiredColumns].filter((col) => !headerSet.has(col))
  if (missingCols.length > 0) {
    return {
      ok: false,
      errors: [`missing required columns: ${[...new Set(missingCols)].join(', ')}`]
    }
  }

  const rowsById = new Map<string, Record<string, string>>()
  const duplicateIds: string[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitTableLine(lines[i], format)
    if (cols.length < header.length) {
      return {
        ok: false,
        errors: [`row ${i} is truncated (${cols.length} < ${header.length} columns)`]
      }
    }
    const row: Record<string, string> = {}
    for (let c = 0; c < header.length; c += 1) {
      row[header[c]] = cols[c]?.trim() ?? ''
    }
    const id = row[idColumn]
    if (!id) {
      return { ok: false, errors: [`row ${i} has empty "${idColumn}" value`] }
    }
    if (rowsById.has(id)) duplicateIds.push(id)
    else rowsById.set(id, row)
  }

  return {
    ok: true,
    table: { header, rowsById, duplicateIds, rowCount: lines.length - 1 }
  }
}

function parseFinite(value: string | undefined): number | undefined {
  if (value === undefined || value === '' || /^(na|nan|null|inf|-inf)$/i.test(value)) {
    return undefined
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function isWithinTolerance(
  candidate: number,
  reference: number,
  absTol: number,
  relTol: number
): boolean {
  return Math.abs(candidate - reference) <= absTol + relTol * Math.abs(reference)
}

export function scoreTabularArtifact(
  workspaceDir: string,
  rule: TabularScoringRule
): ArtifactScoreRecord {
  const candidateAbs = resolve(workspaceDir, rule.candidatePath)
  const requiredCols = [
    ...rule.numericColumns,
    ...(rule.directionColumn ? [rule.directionColumn] : [])
  ]
  const refParsed = parseTableFile(rule.referencePath, rule.format, rule.idColumn, requiredCols)
  if (!refParsed.ok) {
    throw new Error(
      `Invalid hidden reference for ${rule.artifactId}: ${refParsed.errors.join('; ')}`
    )
  }
  const candParsed = parseTableFile(candidateAbs, rule.format, rule.idColumn, requiredCols)
  if (!candParsed.ok) {
    return {
      artifactId: rule.artifactId,
      candidatePath: rule.candidatePath,
      fileValid: false,
      fileErrors: candParsed.errors,
      scientificPass: false,
      score: 0,
      idJaccard: 0,
      valueMatchRate: 0,
      matchedIds: 0,
      referenceIds: refParsed.table.rowsById.size,
      candidateIds: 0,
      notes: candParsed.errors
    }
  }

  const notes: string[] = []
  if (candParsed.table.duplicateIds.length > 0) {
    notes.push(`duplicate IDs detected (${candParsed.table.duplicateIds.length})`)
  }

  const refIds = refParsed.table.rowsById
  const candIds = candParsed.table.rowsById
  let intersection = 0
  for (const id of refIds.keys()) {
    if (candIds.has(id)) intersection += 1
  }
  const union = refIds.size + candIds.size - intersection
  const idJaccard = union > 0 ? intersection / union : 0

  let totalCells = 0
  let matchedCells = 0
  let dirTotal = 0
  let dirMatched = 0

  for (const [id, refRow] of refIds.entries()) {
    const candRow = candIds.get(id)
    if (!candRow) continue
    for (const col of rule.numericColumns) {
      const refVal = parseFinite(refRow[col])
      if (refVal === undefined) continue
      totalCells += 1
      const candVal = parseFinite(candRow[col])
      if (candVal !== undefined && isWithinTolerance(candVal, refVal, rule.absTol, rule.relTol)) {
        matchedCells += 1
      }
    }
    if (rule.directionColumn) {
      const refDir = parseFinite(refRow[rule.directionColumn])
      if (refDir !== undefined && refDir !== 0) {
        dirTotal += 1
        const candDir = parseFinite(candRow[rule.directionColumn])
        if (candDir !== undefined && Math.sign(candDir) === Math.sign(refDir)) {
          dirMatched += 1
        }
      }
    }
  }

  const valueMatchRate = totalCells > 0 ? matchedCells / totalCells : 0
  const directionAgreement =
    rule.directionColumn && dirTotal > 0 ? dirMatched / dirTotal : undefined

  const passJaccard = idJaccard >= rule.minIdJaccard
  const passValues = valueMatchRate >= rule.minValueMatchRate
  const passDirection =
    rule.minDirectionAgreement === undefined ||
    directionAgreement === undefined ||
    directionAgreement >= rule.minDirectionAgreement
  const passNoDupes = candParsed.table.duplicateIds.length === 0

  if (!passJaccard) notes.push(`ID Jaccard ${idJaccard.toFixed(4)} < ${rule.minIdJaccard}`)
  if (!passValues)
    notes.push(`value match rate ${valueMatchRate.toFixed(4)} < ${rule.minValueMatchRate}`)
  if (!passDirection && directionAgreement !== undefined) {
    notes.push(
      `direction agreement ${directionAgreement.toFixed(4)} < ${rule.minDirectionAgreement}`
    )
  }

  const scientificPass = passJaccard && passValues && passDirection && passNoDupes
  const score = Number(((idJaccard + valueMatchRate) / 2).toFixed(6))

  return {
    artifactId: rule.artifactId,
    candidatePath: rule.candidatePath,
    fileValid: true,
    fileErrors: [],
    scientificPass,
    score,
    idJaccard: Number(idJaccard.toFixed(6)),
    valueMatchRate: Number(valueMatchRate.toFixed(6)),
    ...(directionAgreement !== undefined
      ? { directionAgreement: Number(directionAgreement.toFixed(6)) }
      : {}),
    matchedIds: intersection,
    referenceIds: refIds.size,
    candidateIds: candIds.size,
    notes
  }
}

export function scoreTrial(input: {
  taskId: string
  taskVersion: string
  trialId: string
  workspaceDir: string
  executionOutcome: TrialExecutionOutcome
  systemClaim: SystemClaim
  expectsRejection?: boolean
  rules: readonly TabularScoringRule[]
  scoredAt?: string
}): TrialScoreReport {
  const scoredAt = input.scoredAt ?? new Date().toISOString()

  if (input.executionOutcome === 'timeout') {
    return {
      scorerVersion: SCORER_VERSION,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      trialId: input.trialId,
      scoredAt,
      fileValidity: 'invalid',
      scientificScore: { status: 'timeout', score: 0, artifacts: [] },
      systemClaim: input.systemClaim,
      falseSuccessClaim: input.systemClaim === 'claimed_success'
    }
  }

  if (input.expectsRejection) {
    const properlyRejected =
      input.systemClaim === 'rejected_input' ||
      input.systemClaim === 'claimed_failure' ||
      input.executionOutcome === 'failed'
    return {
      scorerVersion: SCORER_VERSION,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      trialId: input.trialId,
      scoredAt,
      fileValidity: 'valid',
      scientificScore: {
        status:
          properlyRejected && input.systemClaim !== 'claimed_success'
            ? 'rejected_invalid_input'
            : 'failed',
        score: properlyRejected && input.systemClaim !== 'claimed_success' ? 1 : 0,
        artifacts: []
      },
      systemClaim: input.systemClaim,
      falseSuccessClaim: input.systemClaim === 'claimed_success'
    }
  }

  if (input.executionOutcome === 'failed' || input.executionOutcome === 'cancelled') {
    return {
      scorerVersion: SCORER_VERSION,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      trialId: input.trialId,
      scoredAt,
      fileValidity: 'invalid',
      scientificScore: { status: 'run_failed', score: 0, artifacts: [] },
      systemClaim: input.systemClaim,
      falseSuccessClaim: input.systemClaim === 'claimed_success'
    }
  }

  try {
    const artifacts = input.rules.map((rule) => scoreTabularArtifact(input.workspaceDir, rule))
    const allFilesValid = artifacts.length > 0 && artifacts.every((a) => a.fileValid)
    const allPassed = artifacts.length > 0 && artifacts.every((a) => a.scientificPass)
    const meanScore =
      artifacts.length > 0
        ? Number((artifacts.reduce((sum, a) => sum + a.score, 0) / artifacts.length).toFixed(6))
        : 0

    return {
      scorerVersion: SCORER_VERSION,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      trialId: input.trialId,
      scoredAt,
      fileValidity: allFilesValid ? 'valid' : 'invalid',
      scientificScore: {
        status: allPassed ? 'passed' : 'failed',
        score: meanScore,
        artifacts
      },
      systemClaim: input.systemClaim,
      falseSuccessClaim: input.systemClaim === 'claimed_success' && !allPassed
    }
  } catch (error) {
    return {
      scorerVersion: SCORER_VERSION,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      trialId: input.trialId,
      scoredAt,
      fileValidity: 'invalid',
      scientificScore: {
        status: 'scorer_error',
        score: null,
        artifacts: [],
        error: error instanceof Error ? error.message : String(error)
      },
      systemClaim: input.systemClaim,
      falseSuccessClaim: false
    }
  }
}
