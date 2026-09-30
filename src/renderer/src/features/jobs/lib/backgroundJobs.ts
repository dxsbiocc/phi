import type {
  BackgroundAgentJob,
  BackgroundShellJob
} from '../../../../../shared/backgroundJobTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import { canCancelBackgroundRun, resolveWrapperCancelTarget } from '../../wrapper/lib/wrapperView'

export type UnifiedBackgroundJob =
  | { kind: 'agent'; key: string; active: boolean; timestamp: string; run: BackgroundAgentJob }
  | { kind: 'shell'; key: string; active: boolean; timestamp: string; run: BackgroundShellJob }
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

export type BackgroundJobQuery = {
  maxRecent?: number
  /** Finished jobs that ended before this ISO time stay out of the tray. */
  finishedAfter?: string
  dismissedKeys?: ReadonlySet<string>
}

const tray = {
  startedAt: new Date().toISOString(),
  dismissed: new Set<string>()
}

export function backgroundJobTrayStartedAt(): string {
  return tray.startedAt
}

export function dismissBackgroundJobs(keys: readonly string[]): void {
  for (const key of keys) tray.dismissed.add(key)
}

export function dismissedBackgroundJobKeys(): ReadonlySet<string> {
  return tray.dismissed
}

export function resetBackgroundJobTray(startedAt = new Date().toISOString()): void {
  tray.startedAt = startedAt
  tray.dismissed = new Set()
}

export function selectBackgroundJobs(
  agents: readonly BackgroundAgentJob[],
  wrappers: readonly WrapperRun[],
  query: BackgroundJobQuery = {},
  shells: readonly BackgroundShellJob[] = []
): { active: UnifiedBackgroundJob[]; recent: UnifiedBackgroundJob[] } {
  const maxRecent = query.maxRecent ?? 8
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
    ...shells.map((run): UnifiedBackgroundJob => ({
      kind: 'shell',
      key: `shell:${run.agentSessionId}:${run.jobId}`,
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
      .filter((item) => !item.active && belongsInFinishedTray(item, query))
      .sort(newestFirst)
      .slice(0, maxRecent)
  }
}

function belongsInFinishedTray(item: UnifiedBackgroundJob, query: BackgroundJobQuery): boolean {
  if (query.dismissedKeys?.has(item.key)) return false
  if (!query.finishedAfter) return true
  const endedAt = item.run.completedAt
  return Boolean(endedAt && endedAt >= query.finishedAfter)
}
