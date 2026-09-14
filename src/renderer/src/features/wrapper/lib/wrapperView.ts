import type { WrapperRun, WrapperRunPlan } from '../../../../../shared/wrapperTypes'

export function trustTierLabel(tier: string): string {
  if (tier === 'bundled') return '内置'
  if (tier === 'custom') return '自定义'
  return tier
}

export function runStateLabel(state: WrapperRun['state']): string {
  const labels: Record<WrapperRun['state'], string> = {
    created: '已创建',
    validating: '校验中',
    provisioning: '准备中',
    queued: '排队中',
    running: '运行中',
    collecting: '收集结果中',
    completed: '已完成',
    failed: '失败',
    cancelling: '取消中',
    cancelled: '已取消',
    lost: '状态未知'
  }
  return labels[state] ?? state
}

export function runStateColor(
  state: WrapperRun['state']
): 'success' | 'error' | 'info' | 'default' {
  if (state === 'completed') return 'success'
  if (state === 'failed' || state === 'lost') return 'error'
  if (state === 'running' || state === 'collecting' || state === 'provisioning') return 'info'
  return 'default'
}

/** States any executor accepts a cancel for before it's actually running anything — see `runs.ts`'s `cancelWrapperRun` doc comment. */
const PRE_DISPATCH_CANCELLABLE_RUN_STATES: WrapperRun['state'][] = [
  'created',
  'validating',
  'provisioning',
  'queued'
]

/**
 * `slurm-controller` states where the remote job is actually running (or
 * wrapping up) and `cancelWrapperRun` will issue a real `scancel` for it —
 * see that function's doc comment. Local runs can't be cancelled once
 * running (no local kill support exists yet), so this only applies when the
 * run's executor is `slurm-controller`.
 */
const REMOTE_RUNNING_CANCELLABLE_STATES: WrapperRun['state'][] = ['running', 'collecting']

export type WrapperCancelTarget =
  { kind: 'plan'; planId: string } | { kind: 'run'; runId: string } | undefined

/**
 * Picks what a card's Cancel button should act on, and whether it should be
 * enabled at all. Before a plan is submitted, cancelling means
 * `cancelWrapperRunPlan`. Once it's submitted, the plan itself is no longer
 * cancellable (`runs.ts`'s `cancelWrapperRunPlan` refuses a submitted plan
 * outright) — the button needs to switch to `cancelWrapperRun` against the
 * resulting run instead. Bug this replaces: `WrapperPlanCard.tsx` only ever
 * called `cancelWrapperRunPlan` and disabled the button once submitted, so
 * there was no way to cancel a run from the card at all, even though
 * `cancelWrapperRun` already existed and already handles the pre-running
 * states listed above.
 */
export function resolveWrapperCancelTarget(
  plan: Pick<WrapperRunPlan, 'planId' | 'state'>,
  run: Pick<WrapperRun, 'runId' | 'state' | 'executor'> | undefined
): WrapperCancelTarget {
  if (run) {
    const cancellable =
      PRE_DISPATCH_CANCELLABLE_RUN_STATES.includes(run.state) ||
      (run.executor === 'slurm-controller' && REMOTE_RUNNING_CANCELLABLE_STATES.includes(run.state))
    if (cancellable) return { kind: 'run', runId: run.runId }
  }
  if (plan.state === 'valid' || plan.state === 'invalid' || plan.state === 'draft') {
    return { kind: 'plan', planId: plan.planId }
  }
  return undefined
}
