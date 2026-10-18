import type { WrapperResourceClass, WrapperResourceRequest } from './types'

const MEMORY_PATTERN = /^\d+(\.\d+)?\s*(MB|GB|TB)$/i
const TIME_PATTERN = /^\d+[hms]$/i
const MAX_SANE_CPUS = 128

export interface PolicyCheckResult {
  ok: boolean
  errors: string[]
}

/**
 * Rough local resource sanity check — Phase 1 has no scheduler and no
 * cluster policy to consult, so this only catches obviously malformed or
 * absurd requests, not real capacity planning (that arrives with Phase 2's
 * remote resource manager).
 */
export function checkLocalResourceRequestSanity(
  resources: WrapperResourceRequest
): PolicyCheckResult {
  const errors: string[] = []

  if (resources.cpus !== undefined && (resources.cpus < 1 || resources.cpus > MAX_SANE_CPUS)) {
    errors.push(`Invalid CPU request: ${resources.cpus}`)
  }
  if (resources.memory !== undefined && !MEMORY_PATTERN.test(resources.memory)) {
    errors.push(`Invalid memory format; expected a value such as "8 GB": ${resources.memory}`)
  }
  if (resources.time !== undefined && !TIME_PATTERN.test(resources.time)) {
    errors.push(`Invalid time format; expected a value such as "2h": ${resources.time}`)
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Heavy/hpc wrappers must not silently run locally when no remote is
 * configured. Phase 1 has no remote at all, so instead of blocking, this
 * marks the plan as needing an explicit acknowledgement before submit — see
 * docs/design/phi-wrapper-product-prd.md, Execution Policy > Phase 1.
 */
export function requiresHeavyWorkloadAcknowledgement(resourceClass: WrapperResourceClass): boolean {
  return resourceClass === 'heavy' || resourceClass === 'hpc'
}
