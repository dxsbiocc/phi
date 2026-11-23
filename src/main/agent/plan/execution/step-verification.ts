import { resolve } from 'node:path'

import type {
  PlanStep,
  PlanStepVerificationCheck,
  PlanStepVerificationResult
} from '../../../../shared/planRunTypes'
import {
  verifyFileContentAssertion,
  type OutputContentAssertion
} from '../../verification/output-assertions'

function assertionForCheck(check: PlanStepVerificationCheck): OutputContentAssertion {
  switch (check.kind) {
    case 'file_exists':
      return {}
    case 'non_empty_file':
      return { nonEmpty: true }
    case 'json_valid':
      return { nonEmpty: true, format: 'json' }
    case 'table_schema':
      return {
        nonEmpty: true,
        format: check.format ?? 'tsv',
        ...(check.minDataRows !== undefined ? { minDataRows: check.minDataRows } : {}),
        ...(check.minColumns !== undefined ? { minColumns: check.minColumns } : {}),
        ...(check.requiredColumns?.length ? { requiredColumns: check.requiredColumns } : {})
      }
  }
}

/**
 * Evaluates a PlanStep's closed-list read-only verification checks against
 * `rootDir`. Never executes user code and refuses symlink/path escapes.
 */
export function verifyPlanStepChecks(step: PlanStep, rootDir: string): PlanStepVerificationResult {
  if (!step.checks?.length) return { ok: true, failures: [] }
  const failures: string[] = []
  for (const check of step.checks) {
    const target = resolve(rootDir, check.path)
    const verdict = verifyFileContentAssertion(target, assertionForCheck(check), { rootDir })
    if (!verdict.ok) {
      failures.push(`${check.kind}(${check.path}): ${verdict.reason ?? 'verification failed'}`)
    }
  }
  return { ok: failures.length === 0, failures }
}
