import {
  PLAN_DEFAULT_MAX_CONCURRENT,
  type PlanRunState,
  type PlanStep
} from '../../../../shared/planRunTypes'
import { resourcesConflict, type ExecutionResource } from '../../resource-admission'

export interface PlanSchedulerOptions {
  maxConcurrent?: number
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
}

/** Plan paths are advisory and do not grant permission to access a resource. */
function declaredWrites(step: PlanStep): ExecutionResource[] {
  if (step.access !== 'write') return []
  const paths = (step.writes ?? []).map(normalizePrefix).filter(Boolean)
  return (paths.length ? paths.map((path) => path.split('/')) : [[]]).map((segments) => ({
    namespace: 'plan-files',
    segments,
    access: 'exclusive'
  }))
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
    .filter(
      (step) =>
        state.steps[step.id]?.status === 'running' || state.steps[step.id]?.status === 'launching'
    )
    .map((step) => step.id)
  const available = concurrencyLimit(options.maxConcurrent) - runningIds.length
  if (available <= 0) return []

  const running = new Set(runningIds)
  const reservedWrites = state.spec.steps
    .filter((step) => running.has(step.id))
    .flatMap(declaredWrites)
  const selected: string[] = []
  for (const step of state.spec.steps) {
    if (selected.length >= available) break
    if (state.steps[step.id]?.status !== 'pending' || !dependenciesSatisfied(state, step)) continue
    const writes = declaredWrites(step)
    if (resourcesConflict(writes, reservedWrites)) continue
    reservedWrites.push(...writes)
    selected.push(step.id)
  }
  return selected
}
