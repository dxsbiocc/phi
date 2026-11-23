import { resolve } from 'node:path'

import type { PlanSpec, PlanStep } from '../../../shared/planRunTypes'
import { SCIENTIFIC_COMPATIBILITY_RULES_VERSION } from './compatibility'
import { computeArtifactSha256, readScientificContextSidecar } from './sidecar'

/**
 * Evidence staleness propagation & immutable derived rerun planning (R15).
 *
 * Guarantees:
 * - Same-path file replacement (content SHA-256 change), sidecar contextVersion change,
 *   or compatibility rule version bump marks a step directly stale.
 * - Staleness propagates transitively along `dependsOn` ONLY to affected descendants;
 *   unaffected sibling branches remain clean.
 * - Historical `done` steps are never reset in place: instead, `createDerivedRerunPlanSpec`
 *   produces a linked follow-up plan for the stale subgraph.
 */

export interface InputArtifactFingerprint {
  path: string
  contentSha256?: string
  contextVersion?: number
}

export interface StepEvidenceFingerprint {
  stepId: string
  rulesVersion: string
  recordedAt: string
  inputs: InputArtifactFingerprint[]
}

export interface StepStalenessRecord {
  stepId: string
  directReasons: string[]
  propagatedFrom: string[]
}

export interface PlanStalenessReport {
  evaluatedAt: string
  rulesVersion: string
  staleSteps: Record<string, StepStalenessRecord>
  cleanStepIds: string[]
}

export function captureStepEvidenceFingerprint(
  step: PlanStep,
  rootDir: string,
  rulesVersion = SCIENTIFIC_COMPATIBILITY_RULES_VERSION,
  recordedAt = new Date().toISOString()
): StepEvidenceFingerprint {
  const paths = new Set<string>()
  for (const contract of step.inputContracts ?? []) {
    paths.add(contract.path)
    if (contract.mustMatchReferenceWith) paths.add(contract.mustMatchReferenceWith)
    if (contract.requireSampleMatchWith) paths.add(contract.requireSampleMatchWith)
  }

  const inputs: InputArtifactFingerprint[] = [...paths].sort().map((relPath) => {
    const abs = resolve(rootDir, relPath)
    const contentSha256 = computeArtifactSha256(abs)
    const { found, sidecar } = readScientificContextSidecar(abs)
    return {
      path: relPath,
      ...(contentSha256 ? { contentSha256 } : {}),
      ...(found ? { contextVersion: sidecar.artifact.contextVersion } : {})
    }
  })

  return {
    stepId: step.id,
    rulesVersion,
    recordedAt,
    inputs
  }
}

function collectDirectStalenessReasons(
  recorded: StepEvidenceFingerprint,
  rootDir: string,
  currentRulesVersion: string
): string[] {
  const reasons: string[] = []
  if (recorded.rulesVersion !== currentRulesVersion) {
    reasons.push(`compatibility rules changed (${recorded.rulesVersion} -> ${currentRulesVersion})`)
  }
  for (const prev of recorded.inputs) {
    const abs = resolve(rootDir, prev.path)
    const currentHash = computeArtifactSha256(abs)
    if (prev.contentSha256 !== currentHash) {
      reasons.push(
        currentHash === undefined
          ? `input "${prev.path}" is now missing`
          : `input "${prev.path}" content changed (same-path replacement detected)`
      )
    }
    const { found, sidecar } = readScientificContextSidecar(abs)
    const currentCtxVersion = found ? sidecar.artifact.contextVersion : undefined
    if (prev.contextVersion !== currentCtxVersion) {
      reasons.push(
        `input "${prev.path}" scientific context version changed (${String(prev.contextVersion)} -> ${String(currentCtxVersion)})`
      )
    }
  }
  return reasons
}

function propagateStaleness(
  steps: readonly PlanStep[],
  directStaleIds: Iterable<string>
): Map<string, Set<string>> {
  const dependents = new Map<string, string[]>()
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      const list = dependents.get(dep) ?? []
      list.push(step.id)
      dependents.set(dep, list)
    }
  }

  const propagatedFrom = new Map<string, Set<string>>()
  const queue = [...directStaleIds]
  const visited = new Set<string>(queue)
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const child of dependents.get(current) ?? []) {
      const sources = propagatedFrom.get(child) ?? new Set<string>()
      sources.add(current)
      propagatedFrom.set(child, sources)
      if (!visited.has(child)) {
        visited.add(child)
        queue.push(child)
      }
    }
  }
  return propagatedFrom
}

export function evaluatePlanStaleness(
  spec: PlanSpec,
  recordedFingerprints: Readonly<Record<string, StepEvidenceFingerprint>>,
  rootDir: string,
  currentRulesVersion = SCIENTIFIC_COMPATIBILITY_RULES_VERSION
): PlanStalenessReport {
  const directReasonsByStep = new Map<string, string[]>()
  for (const step of spec.steps) {
    const recorded = recordedFingerprints[step.id]
    if (!recorded) continue
    const reasons = collectDirectStalenessReasons(recorded, rootDir, currentRulesVersion)
    if (reasons.length > 0) directReasonsByStep.set(step.id, reasons)
  }

  const propagatedFrom = propagateStaleness(spec.steps, directReasonsByStep.keys())
  const staleSteps: Record<string, StepStalenessRecord> = {}
  const cleanStepIds: string[] = []

  for (const step of spec.steps) {
    const directReasons = directReasonsByStep.get(step.id) ?? []
    const prop = [...(propagatedFrom.get(step.id) ?? [])].sort()
    if (directReasons.length > 0 || prop.length > 0) {
      staleSteps[step.id] = { stepId: step.id, directReasons, propagatedFrom: prop }
    } else {
      cleanStepIds.push(step.id)
    }
  }

  return {
    evaluatedAt: new Date().toISOString(),
    rulesVersion: currentRulesVersion,
    staleSteps,
    cleanStepIds
  }
}

/**
 * Builds a new linked PlanSpec containing only the stale subgraph (preserving
 * original immutable history without resetting historical `done` steps in place).
 */
export function createDerivedRerunPlanSpec(
  parentRunId: string,
  originalSpec: PlanSpec,
  staleStepIds: readonly string[]
): PlanSpec {
  const staleSet = new Set(staleStepIds)
  const steps = originalSpec.steps
    .filter((step) => staleSet.has(step.id))
    .map((step) => ({
      ...step,
      dependsOn: step.dependsOn.filter((dep) => staleSet.has(dep))
    }))

  return {
    ...originalSpec,
    goal: `[Rerun of ${parentRunId}] ${originalSpec.goal}`,
    steps
  }
}
