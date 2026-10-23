import {
  PLAN_DEFAULT_MAX_CONCURRENT,
  type PlanRunState,
  type PlanStep
} from '../../../../shared/planRunTypes'

export interface PlanSchedulerOptions {
  maxConcurrent?: number
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
}

function declaredWrites(step: PlanStep): string[] | null {
  if (step.access !== 'write' || !step.writes?.length) return null
  const prefixes = step.writes.map(normalizePrefix).filter(Boolean)
  return prefixes.length ? prefixes : null
}

function prefixesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function writesConflict(left: PlanStep, right: PlanStep): boolean {
  if (left.access !== 'write' || right.access !== 'write') return false
  const leftWrites = declaredWrites(left)
  const rightWrites = declaredWrites(right)
  if (!leftWrites || !rightWrites) return true
  return leftWrites.some((a) => rightWrites.some((b) => prefixesOverlap(a, b)))
}

function dependenciesSatisfied(state: PlanRunState, step: PlanStep): boolean {
  return step.dependsOn.every((id) => {
    const status = state.steps[id]?.status
    return status === 'done' || status === 'skipped'
  })
}

function concurrencyLimit(value: number | undefined): number {
  const requested = value ?? PLAN_DEFAULT_MAX_CONCURRENT
  return Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0
}

export function selectLaunchableSteps(
  state: PlanRunState,
  options: PlanSchedulerOptions = {}
): string[] {
  if (state.status !== 'running') return []
  const runningIds = state.spec.steps
    .filter((step) => state.steps[step.id]?.status === 'running')
    .map((step) => step.id)
  const available = concurrencyLimit(options.maxConcurrent) - runningIds.length
  if (available <= 0) return []

  const byId = new Map(state.spec.steps.map((step) => [step.id, step]))
  const activeWrites = runningIds
    .map((id) => byId.get(id))
    .filter((step): step is PlanStep => step?.access === 'write')
  const selected: PlanStep[] = []
  for (const step of state.spec.steps) {
    if (selected.length >= available) break
    if (state.steps[step.id]?.status !== 'pending' || !dependenciesSatisfied(state, step)) continue
    if (activeWrites.some((active) => writesConflict(step, active))) continue
    if (selected.some((active) => writesConflict(step, active))) continue
    selected.push(step)
  }
  return selected.map((step) => step.id)
}
