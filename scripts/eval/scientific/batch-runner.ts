import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { VisibleEvalTaskCard } from './contract'
import type { TrialExecutionOutcome, TrialScoreReport } from './scorer'

/**
 * Batch production evaluation & core ablation scheduler (R17).
 *
 * Guarantees:
 * - Verifies strict parity for the core ablation (`phi_full` vs `phi_without_context_checks`):
 *   ONLY `enableCrossStepContextChecks` may differ; model, tools, promptVersion,
 *   output assertions, and post-step verification must remain identical.
 * - Generates unique deterministic `trialId`s and seeded interleaved order to remove
 *   time-of-day / order bias across arms.
 * - Resume skips already-terminal trials (`completed`, `failed`, `timeout`, `cancelled`)
 *   without dropping failures from the denominator.
 * - Explicitly separates `dry_run` from `formal` batches and reports `batchCompletenessRate`
 *   independently from `scientificPassRate`.
 */

export interface EvalArmConfig {
  armId: string
  model: string
  promptVersion: string
  tools: string[]
  enableOutputAssertions: boolean
  enablePostStepVerification: boolean
  enableCrossStepContextChecks: boolean
}

export interface CoreAblationParityResult {
  ok: boolean
  errors: string[]
}

export function assertCoreAblationParity(
  fullArm: EvalArmConfig,
  ablatedArm: EvalArmConfig
): CoreAblationParityResult {
  const errors: string[] = []
  if (fullArm.enableCrossStepContextChecks !== true) {
    errors.push('fullArm must have enableCrossStepContextChecks === true')
  }
  if (ablatedArm.enableCrossStepContextChecks !== false) {
    errors.push('ablatedArm must have enableCrossStepContextChecks === false')
  }
  if (fullArm.model !== ablatedArm.model) {
    errors.push(`model mismatch: ${fullArm.model} vs ${ablatedArm.model}`)
  }
  if (fullArm.promptVersion !== ablatedArm.promptVersion) {
    errors.push(`promptVersion mismatch: ${fullArm.promptVersion} vs ${ablatedArm.promptVersion}`)
  }
  if (fullArm.enableOutputAssertions !== ablatedArm.enableOutputAssertions) {
    errors.push('enableOutputAssertions must match between core ablation arms')
  }
  if (fullArm.enablePostStepVerification !== ablatedArm.enablePostStepVerification) {
    errors.push('enablePostStepVerification must match between core ablation arms')
  }
  const fullTools = [...fullArm.tools].sort().join(',')
  const ablatedTools = [...ablatedArm.tools].sort().join(',')
  if (fullTools !== ablatedTools) {
    errors.push(`tools mismatch: [${fullTools}] vs [${ablatedTools}]`)
  }
  return { ok: errors.length === 0, errors }
}

export interface ScheduledTrial {
  trialId: string
  taskId: string
  armId: string
  rep: number
  orderIndex: number
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildBatchSchedule(input: {
  studyId: string
  tasks: readonly Pick<VisibleEvalTaskCard, 'taskId'>[]
  arms: readonly EvalArmConfig[]
  reps: number
  seed: number
}): ScheduledTrial[] {
  const items: Array<Omit<ScheduledTrial, 'orderIndex'>> = []
  for (let rep = 1; rep <= input.reps; rep += 1) {
    for (const task of input.tasks) {
      for (const arm of input.arms) {
        items.push({
          trialId: `${input.studyId}__${task.taskId}__${arm.armId}__rep${rep}`,
          taskId: task.taskId,
          armId: arm.armId,
          rep
        })
      }
    }
  }
  const rng = mulberry32(input.seed)
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items.map((item, orderIndex) => ({ ...item, orderIndex }))
}

export type BatchTrialRecordStatus = TrialExecutionOutcome | 'assembly_error' | 'remote_unknown'

export interface BatchTrialIndexEntry {
  trialId: string
  taskId: string
  armId: string
  rep: number
  status: BatchTrialRecordStatus
  scientificStatus?: TrialScoreReport['scientificScore']['status']
  scientificScore?: number | null
  falseSuccessClaim?: boolean
  error?: string
  updatedAt: string
}

export interface BatchRunSummary {
  batchId: string
  studyId: string
  mode: 'dry_run' | 'formal'
  seed: number
  totalPlanned: number
  terminalCount: number
  batchCompletenessRate: number
  scientificPassCount: number
  scientificPassRate: number
  trials: BatchTrialIndexEntry[]
}

const TERMINAL_BATCH_STATUSES = new Set<BatchTrialRecordStatus>([
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'assembly_error'
])

function readIndex(indexPath: string): Map<string, BatchTrialIndexEntry> {
  if (!existsSync(indexPath)) return new Map()
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
      trials?: BatchTrialIndexEntry[]
    }
    return new Map((parsed.trials ?? []).map((entry) => [entry.trialId, entry]))
  } catch {
    return new Map()
  }
}

export async function runEvalBatch(input: {
  batchId: string
  studyId: string
  mode: 'dry_run' | 'formal'
  batchDir: string
  schedule: readonly ScheduledTrial[]
  executeTrial: (trial: ScheduledTrial) => Promise<{
    status: BatchTrialRecordStatus
    score?: TrialScoreReport
    error?: string
  }>
}): Promise<BatchRunSummary> {
  mkdirSync(input.batchDir, { recursive: true })
  const indexPath = join(input.batchDir, 'batch-index.json')
  const recorded = readIndex(indexPath)

  const persist = (): BatchRunSummary => {
    const trials = input.schedule
      .map((item) => recorded.get(item.trialId))
      .filter((entry): entry is BatchTrialIndexEntry => entry !== undefined)
    const terminalCount = trials.filter((t) => TERMINAL_BATCH_STATUSES.has(t.status)).length
    const scientificPassCount = trials.filter(
      (t) => t.scientificStatus === 'passed' || t.scientificStatus === 'rejected_invalid_input'
    ).length
    const summary: BatchRunSummary = {
      batchId: input.batchId,
      studyId: input.studyId,
      mode: input.mode,
      seed: 0,
      totalPlanned: input.schedule.length,
      terminalCount,
      batchCompletenessRate:
        input.schedule.length > 0 ? Number((terminalCount / input.schedule.length).toFixed(6)) : 0,
      scientificPassCount,
      scientificPassRate:
        input.schedule.length > 0
          ? Number((scientificPassCount / input.schedule.length).toFixed(6))
          : 0,
      trials
    }
    writeFileSync(indexPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8')
    return summary
  }

  for (const trial of input.schedule) {
    const existing = recorded.get(trial.trialId)
    if (existing && TERMINAL_BATCH_STATUSES.has(existing.status)) {
      continue
    }
    try {
      const outcome = await input.executeTrial(trial)
      recorded.set(trial.trialId, {
        trialId: trial.trialId,
        taskId: trial.taskId,
        armId: trial.armId,
        rep: trial.rep,
        status: outcome.status,
        ...(outcome.score ? { scientificStatus: outcome.score.scientificScore.status } : {}),
        ...(outcome.score ? { scientificScore: outcome.score.scientificScore.score } : {}),
        ...(outcome.score ? { falseSuccessClaim: outcome.score.falseSuccessClaim } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        updatedAt: new Date().toISOString()
      })
    } catch (error) {
      recorded.set(trial.trialId, {
        trialId: trial.trialId,
        taskId: trial.taskId,
        armId: trial.armId,
        rep: trial.rep,
        status: 'assembly_error',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      })
    }
    persist()
  }

  return persist()
}
