import { posix } from 'node:path'

import { isRecord } from '../../../../shared/guards'
import {
  isResearchQuestion,
  MAX_RESEARCH_QUESTION_LENGTH
} from '../../../../shared/kernel-protocol/research-question'
import {
  PLAN_MAX_HYPOTHESES,
  PLAN_MAX_STEPS,
  PLAN_MAX_STEP_ACCEPTANCE_LENGTH,
  PLAN_MAX_STEP_ID_LENGTH,
  PLAN_MAX_STEP_INSTRUCTIONS_LENGTH,
  PLAN_MAX_STEP_TITLE_LENGTH,
  PLAN_SPEC_VERSION,
  PLAN_STEP_CHECK_KINDS,
  type PlanHypothesis,
  type PlanLiteratureReviewDecision,
  type PlanSpec,
  type PlanStep,
  type PlanStepAccess,
  type PlanStepVerificationCheck
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

const ALLOWED_CHECK_KINDS = new Set<string>(PLAN_STEP_CHECK_KINDS)

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number | undefined,
  errors: string[]
): string | undefined {
  if (value === undefined) return undefined
  return readRequiredString(value, field, maxLength, errors)
}

function readBoundedStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  errors: string[]
): string[] | undefined {
  if (value === undefined) return undefined
  const items = readStringArray(value, field, errors)
  if (items.length > maxItems) {
    errors.push(`${field} must contain at most ${maxItems} items.`)
  }
  return items
}

function readTableSchemaCheck(
  raw: Record<string, unknown>,
  relative: string,
  itemLabel: string,
  errors: string[]
): PlanStepVerificationCheck {
  if (raw.format !== undefined && raw.format !== 'tsv' && raw.format !== 'csv') {
    errors.push(`${itemLabel}.format must be "tsv" or "csv".`)
  }
  for (const countKey of ['minDataRows', 'minColumns'] as const) {
    const count = raw[countKey]
    if (
      count !== undefined &&
      (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
    ) {
      errors.push(`${itemLabel}.${countKey} must be a non-negative integer.`)
    }
  }
  const requiredColumns =
    raw.requiredColumns === undefined
      ? undefined
      : readStringArray(raw.requiredColumns, `${itemLabel}.requiredColumns`, errors)
  return {
    kind: 'table_schema',
    path: relative,
    ...(raw.format === 'tsv' || raw.format === 'csv' ? { format: raw.format } : {}),
    ...(typeof raw.minDataRows === 'number' ? { minDataRows: raw.minDataRows } : {}),
    ...(typeof raw.minColumns === 'number' ? { minColumns: raw.minColumns } : {}),
    ...(requiredColumns ? { requiredColumns } : {})
  }
}

function readSingleCheck(
  raw: unknown,
  itemLabel: string,
  errors: string[],
  projectRoot: string | undefined
): PlanStepVerificationCheck | null {
  if (!isRecord(raw)) {
    errors.push(`${itemLabel} must be an object.`)
    return null
  }
  if (typeof raw.kind !== 'string' || !ALLOWED_CHECK_KINDS.has(raw.kind)) {
    errors.push(`${itemLabel}.kind must be one of: ${PLAN_STEP_CHECK_KINDS.join(', ')}.`)
    return null
  }
  const rawPath = readRequiredString(raw.path, `${itemLabel}.path`, undefined, errors)
  if (!rawPath) return null
  const relative = normalizeWritePath(rawPath, projectRoot)
  if (relative === undefined) {
    errors.push(
      `${itemLabel}.path must be a path inside the project, relative to the project root ("${rawPath}" is outside it).`
    )
    return null
  }
  if (raw.kind === 'table_schema') return readTableSchemaCheck(raw, relative, itemLabel, errors)
  return {
    kind: raw.kind as 'file_exists' | 'non_empty_file' | 'json_valid',
    path: relative
  }
}

function readChecks(
  value: unknown,
  label: string,
  errors: string[],
  projectRoot: string | undefined
): PlanStepVerificationCheck[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    errors.push(`${label}.checks must be an array.`)
    return undefined
  }
  return value
    .map((raw, idx) => readSingleCheck(raw, `${label}.checks[${idx}]`, errors, projectRoot))
    .filter((check): check is PlanStepVerificationCheck => check !== null)
}

function readStepOptionalFields(
  value: Record<string, unknown>,
  resolvedAccess: PlanStepAccess,
  label: string,
  errors: string[],
  projectRoot: string | undefined
): Partial<PlanStep> {
  const writes = readWrites(value.writes, resolvedAccess, label, errors, projectRoot)
  const checks = readChecks(value.checks, label, errors, projectRoot)
  const inputContracts = Array.isArray(value.inputContracts)
    ? (value.inputContracts as PlanStep['inputContracts'])
    : undefined
  const hypothesisIds =
    value.hypothesisIds === undefined
      ? undefined
      : readStringArray(value.hypothesisIds, `${label}.hypothesisIds`, errors)
  const agent = readOptionalString(value.agent, `${label}.agent`, undefined, errors)
  return {
    ...(writes ? { writes } : {}),
    ...(checks?.length ? { checks } : {}),
    ...(inputContracts?.length ? { inputContracts } : {}),
    ...(hypothesisIds?.length ? { hypothesisIds } : {}),
    ...(agent ? { agent } : {})
  }
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
  const resolvedAccess: PlanStepAccess = access ?? 'read'
  return {
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
    access: resolvedAccess,
    ...readStepOptionalFields(value, resolvedAccess, label, errors, projectRoot)
  }
}

const MAX_HYPOTHESIS_TEXT_LENGTH = 400
const MAX_LITERATURE_SYNTHESIS_LENGTH = 1_000
const MAX_LITERATURE_REFERENCES = 10
const MAX_LITERATURE_DATABASES = 10
const MAX_HYPOTHESIS_CONFOUNDERS = 8

function readLiteratureReview(
  value: unknown,
  errors: string[]
): PlanLiteratureReviewDecision | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    errors.push('literatureReview must be an object.')
    return undefined
  }
  if (typeof value.needed !== 'boolean') {
    errors.push('literatureReview.needed must be a boolean.')
  }
  const rationale = readRequiredString(
    value.rationale,
    'literatureReview.rationale',
    MAX_HYPOTHESIS_TEXT_LENGTH,
    errors
  )
  const scope = readOptionalString(
    value.scope,
    'literatureReview.scope',
    MAX_HYPOTHESIS_TEXT_LENGTH,
    errors
  )
  const databases = readBoundedStringArray(
    value.databases,
    'literatureReview.databases',
    MAX_LITERATURE_DATABASES,
    errors
  )
  const synthesis = readOptionalString(
    value.synthesis,
    'literatureReview.synthesis',
    MAX_LITERATURE_SYNTHESIS_LENGTH,
    errors
  )
  const references = readBoundedStringArray(
    value.references,
    'literatureReview.references',
    MAX_LITERATURE_REFERENCES,
    errors
  )
  return {
    needed: value.needed === true,
    rationale,
    ...(scope ? { scope } : {}),
    ...(databases?.length ? { databases } : {}),
    ...(synthesis ? { synthesis } : {}),
    ...(references?.length ? { references } : {})
  }
}

function readHypothesisItem(
  raw: unknown,
  index: number,
  ids: Set<string>,
  errors: string[]
): PlanHypothesis | null {
  const fallback = `hypotheses[${index}]`
  if (!isRecord(raw)) {
    errors.push(`${fallback} must be an object.`)
    return null
  }
  const id = readRequiredString(raw.id, `${fallback}.id`, PLAN_MAX_STEP_ID_LENGTH, errors)
  if (id && !STEP_ID_PATTERN.test(id)) {
    errors.push(`${fallback}.id must match [a-z0-9-]{1,${PLAN_MAX_STEP_ID_LENGTH}}.`)
  }
  if (id && ids.has(id)) errors.push(`hypothesis "${id}".id must be unique within the plan.`)
  if (id) ids.add(id)
  const statement = readRequiredString(
    raw.statement,
    `${fallback}.statement`,
    MAX_HYPOTHESIS_TEXT_LENGTH,
    errors
  )
  if (typeof raw.selected !== 'boolean') errors.push(`${fallback}.selected must be a boolean.`)
  const mechanism = readOptionalString(
    raw.mechanism,
    `${fallback}.mechanism`,
    MAX_HYPOTHESIS_TEXT_LENGTH,
    errors
  )
  const rationale = readOptionalString(
    raw.rationale,
    `${fallback}.rationale`,
    MAX_HYPOTHESIS_TEXT_LENGTH,
    errors
  )
  const prediction = readOptionalString(
    raw.prediction,
    `${fallback}.prediction`,
    MAX_HYPOTHESIS_TEXT_LENGTH,
    errors
  )
  const testCriteria = readOptionalString(
    raw.testCriteria,
    `${fallback}.testCriteria`,
    MAX_HYPOTHESIS_TEXT_LENGTH,
    errors
  )
  const falsificationCriteria = readOptionalString(
    raw.falsificationCriteria,
    `${fallback}.falsificationCriteria`,
    MAX_HYPOTHESIS_TEXT_LENGTH,
    errors
  )
  const confounders = readBoundedStringArray(
    raw.confounders,
    `${fallback}.confounders`,
    MAX_HYPOTHESIS_CONFOUNDERS,
    errors
  )
  return {
    id,
    statement,
    selected: raw.selected === true,
    ...(mechanism ? { mechanism } : {}),
    ...(rationale ? { rationale } : {}),
    ...(prediction ? { prediction } : {}),
    ...(testCriteria ? { testCriteria } : {}),
    ...(falsificationCriteria ? { falsificationCriteria } : {}),
    ...(confounders?.length ? { confounders } : {})
  }
}

function readHypotheses(value: unknown, errors: string[]): PlanHypothesis[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    errors.push('hypotheses must be an array.')
    return undefined
  }
  if (value.length < 1 || value.length > PLAN_MAX_HYPOTHESES) {
    errors.push(`hypotheses must contain between 1 and ${PLAN_MAX_HYPOTHESES} items.`)
    return undefined
  }
  const ids = new Set<string>()
  const hypotheses = value
    .map((raw, index) => readHypothesisItem(raw, index, ids, errors))
    .filter((item): item is PlanHypothesis => item !== null)
  if (hypotheses.length > 0 && !hypotheses.some((item) => item.selected)) {
    errors.push('hypotheses must mark at least one hypothesis as selected.')
  }
  return hypotheses
}

function validateStepHypothesisReferences(
  steps: PlanStep[],
  hypotheses: PlanHypothesis[] | undefined,
  errors: string[]
): void {
  const knownIds = new Set((hypotheses ?? []).map((item) => item.id))
  for (const step of steps) {
    for (const hypothesisId of step.hypothesisIds ?? []) {
      if (!knownIds.has(hypothesisId)) {
        errors.push(
          `step "${step.id}".hypothesisIds references missing hypothesis "${hypothesisId}".`
        )
      }
    }
  }
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

function readResearchQuestion(value: unknown, errors: string[]): string | undefined {
  if (value === undefined) return undefined
  if (isResearchQuestion(value)) return value
  errors.push(
    `researchQuestion must be a non-empty question of at most ${MAX_RESEARCH_QUESTION_LENGTH} characters.`
  )
  return undefined
}

export function validatePlanSpec(value: unknown, projectRoot?: string): PlanSpecValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['Plan spec must be an object.'] }
  if (value.version !== PLAN_SPEC_VERSION) {
    errors.push(`version must be ${PLAN_SPEC_VERSION}.`)
  }
  const goal = readRequiredString(value.goal, 'goal', undefined, errors)
  const researchQuestion = readResearchQuestion(value.researchQuestion, errors)
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
  if (researchQuestion && steps.some((step) => step.dependsOn.length > 0)) {
    errors.push(
      'A research plan is one review stage. Each step must be independent with an empty dependsOn. Return the current results to the main agent before proposing an analysis that depends on them.'
    )
  }
  const literatureReview = readLiteratureReview(value.literatureReview, errors)
  const hypotheses = readHypotheses(value.hypotheses, errors)
  validateStepReferences(steps, errors)
  validateStepHypothesisReferences(steps, hypotheses, errors)
  const cycleIds = findCycleIds(steps)
  if (cycleIds.length > 0) {
    errors.push(`dependsOn contains a cycle involving step ids: ${cycleIds.join(', ')}.`)
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    spec: {
      version: PLAN_SPEC_VERSION,
      goal,
      ...(researchQuestion ? { researchQuestion } : {}),
      ...(literatureReview ? { literatureReview } : {}),
      ...(hypotheses ? { hypotheses } : {}),
      steps
    }
  }
}
