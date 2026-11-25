import { isRecord } from '../../../../shared/guards'
import type { PlanStepInputContract } from '../../../../shared/planRunTypes'
import {
  MATRIX_VALUE_SEMANTICS,
  type MatrixValueSemantics
} from '../../../../shared/scientificContextTypes'

const ALLOWED_MATRIX_SEMANTICS = new Set<string>(MATRIX_VALUE_SEMANTICS)
const MAX_ASSEMBLY_LENGTH = 120
const MAX_INPUT_CONTRACTS = 20

function readContractPath(
  rawPath: unknown,
  field: string,
  errors: string[],
  normalizePath: (value: string) => string | undefined
): string | undefined {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    errors.push(`${field} must be a non-empty string.`)
    return undefined
  }
  const trimmed = rawPath.trim()
  const relative = normalizePath(trimmed)
  if (relative === undefined) {
    errors.push(
      `${field} must be a path inside the project, relative to the project root ("${trimmed}" is outside it).`
    )
    return undefined
  }
  return relative
}

function readMatrixSemanticsList(
  value: unknown,
  field: string,
  errors: string[]
): MatrixValueSemantics[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array of matrix semantics.`)
    return undefined
  }
  const parsed: MatrixValueSemantics[] = []
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !ALLOWED_MATRIX_SEMANTICS.has(item)) {
      errors.push(`${field}[${index}] must be one of: ${MATRIX_VALUE_SEMANTICS.join(', ')}.`)
      return
    }
    parsed.push(item as MatrixValueSemantics)
  })
  return [...new Set(parsed)]
}

function readExpectedAssembly(value: unknown, field: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value.trim()).length > MAX_ASSEMBLY_LENGTH
  ) {
    errors.push(`${field} must be a non-empty string of at most ${MAX_ASSEMBLY_LENGTH} characters.`)
    return undefined
  }
  return value.trim()
}

function readOptionalContractPath(
  value: unknown,
  field: string,
  errors: string[],
  normalizePath: (value: string) => string | undefined
): string | undefined {
  return value === undefined ? undefined : readContractPath(value, field, errors, normalizePath)
}

function readSingleInputContract(
  raw: unknown,
  itemLabel: string,
  errors: string[],
  normalizePath: (value: string) => string | undefined
): PlanStepInputContract | null {
  if (!isRecord(raw)) {
    errors.push(`${itemLabel} must be an object.`)
    return null
  }
  const path = readContractPath(raw.path, `${itemLabel}.path`, errors, normalizePath)
  if (!path) return null

  const expectedReferenceAssembly = readExpectedAssembly(
    raw.expectedReferenceAssembly,
    `${itemLabel}.expectedReferenceAssembly`,
    errors
  )
  const mustMatchReferenceWith = readOptionalContractPath(
    raw.mustMatchReferenceWith,
    `${itemLabel}.mustMatchReferenceWith`,
    errors,
    normalizePath
  )
  const requiredMatrixSemantics = readMatrixSemanticsList(
    raw.requiredMatrixSemantics,
    `${itemLabel}.requiredMatrixSemantics`,
    errors
  )
  const requireSampleMatchWith = readOptionalContractPath(
    raw.requireSampleMatchWith,
    `${itemLabel}.requireSampleMatchWith`,
    errors,
    normalizePath
  )
  if (raw.requireDonorMapping !== undefined && typeof raw.requireDonorMapping !== 'boolean') {
    errors.push(`${itemLabel}.requireDonorMapping must be a boolean.`)
  }
  const result: PlanStepInputContract = { path }
  if (expectedReferenceAssembly) result.expectedReferenceAssembly = expectedReferenceAssembly
  if (mustMatchReferenceWith) result.mustMatchReferenceWith = mustMatchReferenceWith
  if (requiredMatrixSemantics?.length) result.requiredMatrixSemantics = requiredMatrixSemantics
  if (requireSampleMatchWith) result.requireSampleMatchWith = requireSampleMatchWith
  if (typeof raw.requireDonorMapping === 'boolean') {
    result.requireDonorMapping = raw.requireDonorMapping
  }
  return result
}

export function readInputContracts(
  value: unknown,
  label: string,
  errors: string[],
  normalizePath: (value: string) => string | undefined
): PlanStepInputContract[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    errors.push(`${label}.inputContracts must be an array.`)
    return undefined
  }
  if (value.length > MAX_INPUT_CONTRACTS) {
    errors.push(`${label}.inputContracts must contain at most ${MAX_INPUT_CONTRACTS} items.`)
    return undefined
  }
  return value
    .map((raw, idx) =>
      readSingleInputContract(raw, `${label}.inputContracts[${idx}]`, errors, normalizePath)
    )
    .filter((item): item is PlanStepInputContract => item !== null)
}
