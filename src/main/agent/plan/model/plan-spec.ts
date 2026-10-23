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

function isUnsafeWritePath(value: string): boolean {
  const segments = value.split(/[\\/]+/)
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    WINDOWS_ABSOLUTE_PATTERN.test(value) ||
    segments.includes('..')
  )
}

function readWrites(
  value: unknown,
  access: PlanStepAccess,
  label: string,
  errors: string[]
): string[] | undefined {
  if (value === undefined) return undefined
  const writes = readStringArray(value, `${label}.writes`, errors)
  if (access === 'read') errors.push(`${label}.writes is only allowed when access is "write".`)
  for (const path of writes) {
    if (isUnsafeWritePath(path)) {
      errors.push(`${label}.writes contains unsafe relative path "${path}".`)
    }
  }
  return writes
}

function readStep(value: unknown, index: number, errors: string[]): PlanStep | null {
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
  const writes = readWrites(value.writes, step.access, label, errors)
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

export function validatePlanSpec(value: unknown): PlanSpecValidationResult {
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
    .map((step, index) => readStep(step, index, errors))
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
