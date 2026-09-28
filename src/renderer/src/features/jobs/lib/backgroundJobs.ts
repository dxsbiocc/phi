import type { BackgroundAgentJob } from '../../../../../shared/backgroundJobTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import { canCancelBackgroundRun, resolveWrapperCancelTarget } from '../../wrapper/lib/wrapperView'

export type UnifiedBackgroundJob =
  | { kind: 'agent'; key: string; active: boolean; timestamp: string; run: BackgroundAgentJob }
  | { kind: 'wrapper'; key: string; active: boolean; timestamp: string; run: WrapperRun }

const ACTIVE_WRAPPER_STATES = new Set<WrapperRun['state']>([
  'created',
  'validating',
  'provisioning',
  'queued',
  'running',
  'collecting',
  'cancelling'
])

export function canStopUnifiedWrapperRun(run: WrapperRun): boolean {
  if (canCancelBackgroundRun(run)) return true
  return resolveWrapperCancelTarget({ planId: run.planId, state: 'submitted' }, run)?.kind === 'run'
}

export function selectBackgroundJobs(
  agents: readonly BackgroundAgentJob[],
  wrappers: readonly WrapperRun[],
  maxRecent = 8
): { active: UnifiedBackgroundJob[]; recent: UnifiedBackgroundJob[] } {
  const items: UnifiedBackgroundJob[] = [
    ...agents
      .filter((run) => run.background)
      .map((run): UnifiedBackgroundJob => ({
        kind: 'agent',
        key: `agent:${run.agentSessionId}:${run.agentRunId}`,
        active: run.state === 'queued' || run.state === 'running',
        timestamp: run.completedAt ?? run.startedAt,
        run
      })),
    ...wrappers.map((run): UnifiedBackgroundJob => ({
      kind: 'wrapper',
      key: `wrapper:${run.runId}`,
      active: ACTIVE_WRAPPER_STATES.has(run.state),
      timestamp: run.completedAt ?? run.updatedAt,
      run
    }))
  ]
  const newestFirst = (left: UnifiedBackgroundJob, right: UnifiedBackgroundJob): number =>
    right.timestamp.localeCompare(left.timestamp)
  return {
    active: items.filter((item) => item.active).sort(newestFirst),
    recent: items
      .filter((item) => !item.active)
      .sort(newestFirst)
      .slice(0, maxRecent)
  }
}
