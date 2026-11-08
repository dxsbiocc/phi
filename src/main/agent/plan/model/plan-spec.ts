import { posix } from 'node:path'

import { isRecord } from '../../../../shared/guards'
import {
  PLAN_MAX_STEPS,
  PLAN_MAX_STEP_ACCEPTANCE_LENGTH,
  PLAN_MAX_STEP_ID_LENGTH,
  PLAN_MAX_STEP_INSTRUCTIONS_LENGTH,
  PLAN_MAX_STEP_TITLE_LENGTH,
  PLAN_SPEC_VERSION,
  type PlanSpec,
  type PlanStep,
  type PlanStepAccess
} from '../../../../shared/planRunTypes'

export type PlanSpecValidationResult =
  { ok: true; spec: PlanSpec } | { ok: false; errors: string[] }

const STEP_ID_PATTERN = /^[a-z0-9-]{1,40}$/
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/

function characterLength(value: string): number {
  return Array.from(value).length
}

function readRequiredString(
  value: unknown,
  field: string,
  maxLength: number | undefined,
  errors: string[]
): string {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${field} must be a non-empty string.`)
    return ''
  }
  const result = value.trim()
  if (maxLength !== undefined && characterLength(result) > maxLength) {
    errors.push(`${field} must be at most ${maxLength} characters.`)
  }
  return result
}

function readStringArray(value: unknown, field: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings.`)
    return []
  }
  const strings: string[] = []
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push(`${field}[${index}] must be a non-empty string.`)
      return
    }
    strings.push(item.trim())
  })
  return [...new Set(strings)]
}

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/')
}

function normalizeAbsolutePath(value: string): string {
  const normalized = posix.normalize(toPosixPath(value))
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

function comparableAbsolutePath(value: string): string {
  const normalized = normalizeAbsolutePath(value)
  return WINDOWS_ABSOLUTE_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized
}

/** Return the root-relative form of an absolute path inside the project, or undefined. */
function relativeToProjectRoot(value: string, projectRoot: string): string | undefined {
  const root = normalizeAbsolutePath(projectRoot)
  if (!root.startsWith('/') && !WINDOWS_ABSOLUTE_PATTERN.test(root)) return undefined
  const candidate = normalizeAbsolutePath(value)
  const rootKey = comparableAbsolutePath(root)
  const candidateKey = comparableAbsolutePath(candidate)
  if (candidateKey === rootKey) return undefined
  const rootPrefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`
  return candidateKey.startsWith(rootPrefix) ? candidate.slice(rootPrefix.length) : undefined
}

function isAbsoluteWritePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || WINDOWS_ABSOLUTE_PATTERN.test(value)
}

/**
 * Absolute write paths are accepted only when they resolve inside the project and are
 * stored root-relative, so the plan runs correctly on local and SSH projects alike.
 */
function normalizeWritePath(value: string, projectRoot: string | undefined): string | undefined {
  if (value.split(/[\\/]+/).includes('..')) return undefined
  if (!isAbsoluteWritePath(value)) return value
  return projectRoot ? relativeToProjectRoot(value, projectRoot) : undefined
}

function readWrites(
  value: unknown,
  access: PlanStepAccess,
  label: string,
  errors: string[],
  projectRoot: string | undefined
): string[] | undefined {
  if (value === undefined) return undefined
  const writes = readStringArray(value, `${label}.writes`, errors)
  if (access === 'read') errors.push(`${label}.writes is only allowed when access is "write".`)
  const normalized: string[] = []
  for (const path of writes) {
    const relative = normalizeWritePath(path, projectRoot)
    if (relative === undefined) {
      errors.push(
        `${label}.writes must be a path inside the project, relative to the project root ("${path}" is outside it).`
      )
      continue
    }
    normalized.push(relative)
  }
  return [...new Set(normalized)]
}

function readStep(
  value: unknown,
  index: number,
  errors: string[],
  projectRoot: string | undefined
): PlanStep | null {
  const fallback = `steps[${index}]`
  if (!isRecord(value)) {
    errors.push(`${fallback} must be an object.`)
    return null
  }
  const rawId = typeof value.id === 'string' ? value.id.trim() : ''
  const label = rawId ? `step "${rawId}"` : fallback
  const id = readRequiredString(value.id, `${label}.id`, PLAN_MAX_STEP_ID_LENGTH, errors)
  if (id && !STEP_ID_PATTERN.test(id)) {
    errors.push(`${label}.id must match [a-z0-9-]{1,${PLAN_MAX_STEP_ID_LENGTH}}.`)
  }
  const access = value.access === 'read' || value.access === 'write' ? value.access : null
  if (!access) errors.push(`${label}.access must be "read" or "write".`)
  const step: PlanStep = {
    id,
    title: readRequiredString(value.title, `${label}.title`, PLAN_MAX_STEP_TITLE_LENGTH, errors),
    instructions: readRequiredString(
      value.instructions,
      `${label}.instructions`,
      PLAN_MAX_STEP_INSTRUCTIONS_LENGTH,
      errors
    ),
    acceptance: readRequiredString(
      value.acceptance,
      `${label}.acceptance`,
      PLAN_MAX_STEP_ACCEPTANCE_LENGTH,
      errors
    ),
    dependsOn: readStringArray(value.dependsOn, `${label}.dependsOn`, errors),
    access: access ?? 'read'
  }
  const writes = readWrites(value.writes, step.access, label, errors, projectRoot)
  const agent =
    value.agent === undefined
      ? undefined
      : readRequiredString(value.agent, `${label}.agent`, undefined, errors)
  return { ...step, ...(writes ? { writes } : {}), ...(agent ? { agent } : {}) }
}

function validateStepReferences(steps: PlanStep[], errors: string[]): void {
  const ids = new Set<string>()
  for (const step of steps) {
    if (ids.has(step.id)) {
      errors.push(`step "${step.id}".id must be unique within the plan.`)
    }
    ids.add(step.id)
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        errors.push(`step "${step.id}".dependsOn references missing step "${dependency}".`)
      }
    }
  }
}

function findCycleIds(steps: PlanStep[]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const active: string[] = []
  const colors = new Map<string, 0 | 1 | 2>()
  const cycles = new Set<string>()
  const visit = (id: string): void => {
    if (colors.get(id) === 2) return
    if (colors.get(id) === 1) {
      for (const cycleId of active.slice(active.indexOf(id))) cycles.add(cycleId)
      return
    }
    colors.set(id, 1)
    active.push(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency)
    }
    active.pop()
    colors.set(id, 2)
  }
  for (const step of steps) visit(step.id)
  return [...cycles]
}

export function validatePlanSpec(value: unknown, projectRoot?: string): PlanSpecValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['Plan spec must be an object.'] }
  if (value.version !== PLAN_SPEC_VERSION) {
    errors.push(`version must be ${PLAN_SPEC_VERSION}.`)
  }
  const goal = readRequiredString(value.goal, 'goal', undefined, errors)
  if (!Array.isArray(value.steps)) {
    errors.push('steps must be an array.')
    return { ok: false, errors }
  }
  if (value.steps.length < 1 || value.steps.length > PLAN_MAX_STEPS) {
    errors.push(`steps must contain between 1 and ${PLAN_MAX_STEPS} steps.`)
  }
  const steps = value.steps
    .map((step, index) => readStep(step, index, errors, projectRoot))
    .filter((step): step is PlanStep => step !== null)
  validateStepReferences(steps, errors)
  const cycleIds = findCycleIds(steps)
  if (cycleIds.length > 0) {
    errors.push(`dependsOn contains a cycle involving step ids: ${cycleIds.join(', ')}.`)
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, spec: { version: PLAN_SPEC_VERSION, goal, steps } }
}
