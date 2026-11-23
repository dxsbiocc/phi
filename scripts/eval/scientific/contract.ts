import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * Versioned scientific benchmark task contract & evidence directory protocol (R01).
 *
 * Key invariants:
 * - Every formal task MUST declare input provenance, reference genome/annotation version,
 *   visible output contract, resource budget, scoring version, and study/dataset identity.
 * - Agent-visible task cards (`VisibleEvalTaskCard`) are physically separated from hidden
 *   reference specs (`HiddenReferenceSpec`) and never carry ground-truth paths or values.
 * - Any change to a frozen task set produces a new SHA-256 digest; never overwrite compared versions.
 */

export const EVAL_CONTRACT_VERSION = 1 as const

export type EvalTaskSplit = 'dev' | 'heldout'
export type EvalTaskReadiness = 'ready' | 'data_pending'

export interface EvalInputSource {
  /** Public accession (e.g. GSE/PRJNA/SRA) or dataset identifier. */
  accession: string
  /** Frozen dataset/release version or acquisition date. */
  version: string
  /** Concise description of input files staged into the trial workspace. */
  summary: string
  /** Acquisition steps when data is not bundled in the repository. */
  acquisitionSteps: string[]
}

export interface EvalVisibleOutputContract {
  id: string
  /** Relative path inside the trial workspace. */
  path: string
  format: 'tsv' | 'csv' | 'json' | 'html'
  description: string
  requiredColumns?: string[]
  minDataRows?: number
}

export interface EvalResourceBudget {
  maxWallSeconds: number
  maxModelCalls: number
  maxCostUsd: number
  maxCpus?: number
  maxMemoryGb?: number
}

/** What the agent / evaluated system is allowed to see. Contains NO hidden answers. */
export interface VisibleEvalTaskCard {
  contractVersion: typeof EVAL_CONTRACT_VERSION
  taskId: string
  taskVersion: string
  title: string
  /** Study/dataset clustering identity used for paired & clustered statistics (R01/R20). */
  studyId: string
  datasetId: string
  /** Upstream tasks whose data or steps overlap with this task (non-independent cluster). */
  relatedTaskIds: string[]
  split: EvalTaskSplit
  readiness: EvalTaskReadiness
  prompt: string
  inputSource: EvalInputSource
  /** Fixed reference genome / annotation version (e.g. GRCh38 / GENCODE v44). */
  referenceVersion: string
  /** Allowed tool families / wrappers for this task. */
  tools: string[]
  visibleOutputs: EvalVisibleOutputContract[]
  budget: EvalResourceBudget
  scoringVersion: string
}

/** Held strictly outside the agent execution boundary (R03/R09). */
export interface HiddenReferenceSpec {
  taskId: string
  taskVersion: string
  scoringVersion: string
  /** External directory or artifact identifier outside the trial workspace. */
  referenceArtifactKey: string
  /** Frozen tolerance metadata reviewed before unblinding arm comparisons. */
  tolerances: {
    absTol?: number
    relTol?: number
    minJaccard?: number
    directionAgreementMin?: number
  }
  /** True for negative / fault-injection tasks where rejecting invalid input is the right outcome. */
  expectsRejection?: boolean
}

export interface EvalContractValidationResult {
  ok: boolean
  errors: string[]
}

const TASK_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,48}$/
const SEMVER_LIKE = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function validateVisibleTaskCard(card: VisibleEvalTaskCard): EvalContractValidationResult {
  const errors: string[] = []
  if (card.contractVersion !== EVAL_CONTRACT_VERSION) {
    errors.push(`contractVersion must be ${EVAL_CONTRACT_VERSION}`)
  }
  if (!nonEmpty(card.taskId) || !TASK_ID_PATTERN.test(card.taskId)) {
    errors.push(`taskId "${card.taskId}" must match ${TASK_ID_PATTERN}`)
  }
  if (!nonEmpty(card.taskVersion) || !SEMVER_LIKE.test(card.taskVersion)) {
    errors.push(`taskVersion "${card.taskVersion}" must be a SemVer string`)
  }
  if (!nonEmpty(card.title)) errors.push('title is required')
  if (!nonEmpty(card.studyId)) errors.push('studyId is required')
  if (!nonEmpty(card.datasetId)) errors.push('datasetId is required')
  if (card.split !== 'dev' && card.split !== 'heldout') {
    errors.push('split must be "dev" or "heldout"')
  }
  if (card.readiness !== 'ready' && card.readiness !== 'data_pending') {
    errors.push('readiness must be "ready" or "data_pending"')
  }
  if (!nonEmpty(card.prompt)) errors.push('prompt is required')
  if (!nonEmpty(card.referenceVersion)) errors.push('referenceVersion is required')
  if (!nonEmpty(card.scoringVersion) || !SEMVER_LIKE.test(card.scoringVersion)) {
    errors.push('scoringVersion must be a SemVer string')
  }
  if (!card.inputSource || !nonEmpty(card.inputSource.accession)) {
    errors.push('inputSource.accession is required')
  }
  if (!card.inputSource || !nonEmpty(card.inputSource.version)) {
    errors.push('inputSource.version is required')
  }
  if (!card.inputSource || !nonEmpty(card.inputSource.summary)) {
    errors.push('inputSource.summary is required')
  }
  if (
    !Array.isArray(card.inputSource?.acquisitionSteps) ||
    card.inputSource.acquisitionSteps.length === 0
  ) {
    errors.push('inputSource.acquisitionSteps must contain at least one step')
  }
  if (!Array.isArray(card.visibleOutputs) || card.visibleOutputs.length === 0) {
    errors.push('visibleOutputs must declare at least one output')
  } else {
    for (const output of card.visibleOutputs) {
      if (!nonEmpty(output.id)) errors.push('visibleOutputs[].id is required')
      if (!nonEmpty(output.path) || output.path.startsWith('/') || output.path.includes('..')) {
        errors.push(`visibleOutputs["${output.id}"].path must be a safe workspace-relative path`)
      }
    }
  }
  if (
    !card.budget ||
    !(card.budget.maxWallSeconds > 0) ||
    !(card.budget.maxModelCalls > 0) ||
    !(card.budget.maxCostUsd > 0)
  ) {
    errors.push('budget must specify positive maxWallSeconds, maxModelCalls, and maxCostUsd')
  }

  // Guard against accidental leakage of hidden ground-truth fields into visible cards.
  const raw = card as unknown as Record<string, unknown>
  for (const forbidden of [
    'hiddenReference',
    'expectedValues',
    'referenceArtifactKey',
    'answerPath'
  ]) {
    if (forbidden in raw) {
      errors.push(`visible task card must not contain hidden field "${forbidden}"`)
    }
  }

  return { ok: errors.length === 0, errors }
}

/** Strips any accidental extra fields and returns a clean agent-visible task card. */
export function extractVisibleTaskCard(card: VisibleEvalTaskCard): VisibleEvalTaskCard {
  return {
    contractVersion: card.contractVersion,
    taskId: card.taskId,
    taskVersion: card.taskVersion,
    title: card.title,
    studyId: card.studyId,
    datasetId: card.datasetId,
    relatedTaskIds: [...card.relatedTaskIds],
    split: card.split,
    readiness: card.readiness,
    prompt: card.prompt,
    inputSource: {
      accession: card.inputSource.accession,
      version: card.inputSource.version,
      summary: card.inputSource.summary,
      acquisitionSteps: [...card.inputSource.acquisitionSteps]
    },
    referenceVersion: card.referenceVersion,
    tools: [...card.tools],
    visibleOutputs: card.visibleOutputs.map((out) => ({
      ...out,
      ...(out.requiredColumns ? { requiredColumns: [...out.requiredColumns] } : {})
    })),
    budget: { ...card.budget },
    scoringVersion: card.scoringVersion
  }
}

/** Deterministic SHA-256 fingerprint of a frozen task set and its scoring versions. */
export function freezeTaskSetDigest(cards: readonly VisibleEvalTaskCard[]): string {
  const normalized = [...cards]
    .map(extractVisibleTaskCard)
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export interface TrialEvidencePaths {
  rootDir: string
  configJson: string
  eventsJsonl: string
  artifactsIndexJson: string
  verificationJson: string
  scoreJson: string
  usageJson: string
  interventionsJson: string
}

/** Canonical trial evidence directory layout (`artifacts/research/<studyId>/<trialId>/`). */
export function trialEvidencePaths(
  baseArtifactsDir: string,
  studyId: string,
  trialId: string
): TrialEvidencePaths {
  const rootDir = join(baseArtifactsDir, 'research', studyId, trialId)
  return {
    rootDir,
    configJson: join(rootDir, 'config.json'),
    eventsJsonl: join(rootDir, 'events.jsonl'),
    artifactsIndexJson: join(rootDir, 'artifacts-index.json'),
    verificationJson: join(rootDir, 'verification.json'),
    scoreJson: join(rootDir, 'score.json'),
    usageJson: join(rootDir, 'usage.json'),
    interventionsJson: join(rootDir, 'interventions.json')
  }
}
