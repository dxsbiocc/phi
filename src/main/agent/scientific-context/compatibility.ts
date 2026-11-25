import { resolve } from 'node:path'

import type { PlanStep, PlanStepPreflightResult } from '../../../shared/planRunTypes'
import type { ScientificContextSidecar } from '../../../shared/scientificContextTypes'
import { readScientificContextSidecar } from './sidecar'

/**
 * Cross-step scientific compatibility checker (R14).
 *
 * Evaluated before `PlanExecutor.launch()` dispatches a downstream step:
 * - Missing / `unknown` required scientific metadata -> `needs_input` (never guessed!)
 * - Explicit scientific contradiction (wrong matrix semantics, mismatched reference
 *   assembly, mismatched sample sets, or missing donor mapping) -> `incompatible`.
 * - Compatible verified metadata -> `compatible`.
 */

export const SCIENTIFIC_COMPATIBILITY_RULES_VERSION = '1.0.0'

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  if (setA.size !== b.length) return false
  return b.every((item) => setA.has(item))
}

function checkContractDonorMapping(
  contract: NonNullable<PlanStep['inputContracts']>[number],
  sidecar: ReturnType<typeof readScientificContextSidecar>['sidecar'],
  reasons: string[],
  missingInputs: string[]
): void {
  if (!contract.requireDonorMapping) return
  if (sidecar.samples.status === 'unknown') {
    missingInputs.push(`Sample/donor mapping for "${contract.path}" is unknown`)
    return
  }
  const donorMap = sidecar.samples.value.donorBySample
  if (!donorMap) {
    missingInputs.push(`Donor mapping (donorBySample) missing for "${contract.path}"`)
    return
  }
  const unmapped = sidecar.samples.value.sampleIds.filter(
    (id) => typeof donorMap[id] !== 'string' || donorMap[id].trim().length === 0
  )
  if (unmapped.length > 0) {
    reasons.push(`Missing donor mapping for samples in "${contract.path}": ${unmapped.join(', ')}`)
  }
}

function checkResolvedReference(
  contract: NonNullable<PlanStep['inputContracts']>[number],
  sidecar: ScientificContextSidecar,
  resolveSidecar: (contractPath: string) => ScientificContextSidecar,
  reasons: string[],
  missingInputs: string[]
): void {
  if (contract.expectedReferenceAssembly) {
    if (sidecar.reference.status === 'unknown') {
      missingInputs.push(
        `Reference assembly for "${contract.path}" is unknown (expected ${contract.expectedReferenceAssembly})`
      )
    } else if (sidecar.reference.value.assembly !== contract.expectedReferenceAssembly) {
      reasons.push(
        `Reference assembly mismatch for "${contract.path}": found ${sidecar.reference.value.assembly}, expected ${contract.expectedReferenceAssembly}`
      )
    }
  }
  if (!contract.mustMatchReferenceWith) return
  const peer = resolveSidecar(contract.mustMatchReferenceWith)
  if (sidecar.reference.status === 'unknown' || peer.reference.status === 'unknown') {
    missingInputs.push(
      `Reference assembly unknown for "${contract.path}" or "${contract.mustMatchReferenceWith}"`
    )
  } else if (sidecar.reference.value.assembly !== peer.reference.value.assembly) {
    reasons.push(
      `Reference mismatch between "${contract.path}" (${sidecar.reference.value.assembly}) and "${contract.mustMatchReferenceWith}" (${peer.reference.value.assembly})`
    )
  }
}

function checkResolvedMatrixAndSamples(
  contract: NonNullable<PlanStep['inputContracts']>[number],
  sidecar: ScientificContextSidecar,
  resolveSidecar: (contractPath: string) => ScientificContextSidecar,
  reasons: string[],
  missingInputs: string[]
): void {
  if (contract.requiredMatrixSemantics?.length) {
    if (sidecar.matrix.status === 'unknown') {
      missingInputs.push(
        `Matrix value semantics for "${contract.path}" is unknown (requires one of: ${contract.requiredMatrixSemantics.join(', ')})`
      )
    } else if (!contract.requiredMatrixSemantics.includes(sidecar.matrix.value.valueSemantics)) {
      reasons.push(
        `Matrix semantics mismatch for "${contract.path}": found "${sidecar.matrix.value.valueSemantics}", requires one of: ${contract.requiredMatrixSemantics.join(', ')}`
      )
    }
  }
  if (!contract.requireSampleMatchWith) return
  const peer = resolveSidecar(contract.requireSampleMatchWith)
  if (sidecar.samples.status === 'unknown' || peer.samples.status === 'unknown') {
    missingInputs.push(
      `Sample IDs unknown for "${contract.path}" or "${contract.requireSampleMatchWith}"`
    )
  } else if (!sameSet(sidecar.samples.value.sampleIds, peer.samples.value.sampleIds)) {
    reasons.push(
      `Sample ID mismatch between "${contract.path}" and "${contract.requireSampleMatchWith}"`
    )
  }
}

function evaluateContractsWithResolver(
  step: PlanStep,
  resolveSidecar: (contractPath: string) => ScientificContextSidecar
): PlanStepPreflightResult {
  if (!step.inputContracts?.length) return { status: 'compatible' }

  const reasons: string[] = []
  const missingInputs: string[] = []

  for (const contract of step.inputContracts) {
    const sidecar = resolveSidecar(contract.path)
    checkResolvedReference(contract, sidecar, resolveSidecar, reasons, missingInputs)
    checkResolvedMatrixAndSamples(contract, sidecar, resolveSidecar, reasons, missingInputs)
    checkContractDonorMapping(contract, sidecar, reasons, missingInputs)
  }

  if (reasons.length > 0) return { status: 'incompatible', reasons }
  if (missingInputs.length > 0) {
    return {
      status: 'needs_input',
      missingInputs,
      summary: `Cross-step scientific metadata missing before launching "${step.id}": ${missingInputs.join('; ')}`
    }
  }
  return { status: 'compatible' }
}

export function evaluateStepScientificCompatibility(
  step: PlanStep,
  rootDir: string
): PlanStepPreflightResult {
  return evaluateContractsWithResolver(
    step,
    (relPath) => readScientificContextSidecar(resolve(rootDir, relPath)).sidecar
  )
}

export async function evaluateAsyncStepScientificCompatibility(
  step: PlanStep,
  loadSidecar: (relPath: string) => Promise<ScientificContextSidecar>
): Promise<PlanStepPreflightResult> {
  if (!step.inputContracts?.length) return { status: 'compatible' }
  const paths = new Set<string>()
  for (const contract of step.inputContracts) {
    paths.add(contract.path)
    if (contract.mustMatchReferenceWith) paths.add(contract.mustMatchReferenceWith)
    if (contract.requireSampleMatchWith) paths.add(contract.requireSampleMatchWith)
  }
  const loaded = new Map<string, ScientificContextSidecar>()
  for (const relPath of paths) {
    loaded.set(relPath, await loadSidecar(relPath))
  }
  return evaluateContractsWithResolver(step, (relPath) => loaded.get(relPath)!)
}
