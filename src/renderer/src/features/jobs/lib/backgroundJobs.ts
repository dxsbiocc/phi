import type { BackgroundAgentJob } from '../../../../../shared/backgroundJobTypes'
import type {
  EnvironmentBuild,
  EnvironmentBuildState
} from '../../../../../shared/environmentBuildTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import { canCancelBackgroundRun, resolveWrapperCancelTarget } from '../../wrapper/lib/wrapperView'

export type UnifiedBackgroundJob =
  | { kind: 'agent'; key: string; active: boolean; timestamp: string; run: BackgroundAgentJob }
  | { kind: 'wrapper'; key: string; active: boolean; timestamp: string; run: WrapperRun }
  | {
      kind: 'environment'
      key: string
      active: boolean
      timestamp: string
      build: EnvironmentBuild
    }

const ACTIVE_WRAPPER_STATES = new Set<WrapperRun['state']>([
  'created',
  'validating',
  'provisioning',
  'queued',
  'running',
  'collecting',
  'cancelling'
])

const ENVIRONMENT_BUILD_STATE_LABELS: Record<EnvironmentBuildState, string> = {
  building: '构建中',
  ready: '已就绪',
  failed: '失败',
  cancelled: '已取消'
}

/** Labels for `EnsureProgressPhase`, plus `cancelled` which the build record sets on abort. */
const ENVIRONMENT_BUILD_PHASE_LABELS: Record<string, string> = {
  check: '检查',
  wait: '等待包缓存',
  create: '下载安装包',
  'source-packages': '安装源码包',
  activation: '激活',
  finalize: '收尾',
  done: '完成',
  failed: '失败',
  cancelled: '已取消'
}

const MB = 1024 ** 2
const GB = 1024 ** 3

export function canStopUnifiedWrapperRun(run: WrapperRun): boolean {
  if (canCancelBackgroundRun(run)) return true
  return resolveWrapperCancelTarget({ planId: run.planId, state: 'submitted' }, run)?.kind === 'run'
}

export function environmentBuildTitle(build: EnvironmentBuild): string {
  return `构建环境 ${build.ref}`
}

export function environmentBuildDetail(build: EnvironmentBuild): string {
  const bytes = knownByteProgress(build)
  return [
    ENVIRONMENT_BUILD_STATE_LABELS[build.state],
    ENVIRONMENT_BUILD_PHASE_LABELS[build.phase] ?? build.phase,
    `${build.progress.packagesDone}/${build.progress.packages} 个包`,
    bytes ? formatByteProgress(bytes.done, bytes.total) : undefined,
    build.state === 'failed' && build.error ? build.error : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}

export function environmentBuildPercent(build: EnvironmentBuild): number | undefined {
  const bytes = knownByteProgress(build)
  if (bytes) return ratioPercent(bytes.done, bytes.total)
  return ratioPercent(build.progress.packagesDone, build.progress.packages)
}

export function selectBackgroundJobs(
  agents: readonly BackgroundAgentJob[],
  wrappers: readonly WrapperRun[],
  environments: readonly EnvironmentBuild[] = [],
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
    })),
    ...environments.map((build): UnifiedBackgroundJob => ({
      kind: 'environment',
      key: `environment:${build.envId}`,
      active: build.state === 'building',
      timestamp: build.finishedAt ?? build.startedAt,
      build
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

function knownByteProgress(build: EnvironmentBuild): { done: number; total: number } | undefined {
  const { bytesDone, bytesTotal } = build.progress
  if (
    bytesDone === undefined ||
    bytesTotal === undefined ||
    !Number.isFinite(bytesDone) ||
    !Number.isFinite(bytesTotal) ||
    bytesDone < 0 ||
    bytesTotal <= 0
  ) {
    return undefined
  }
  return { done: bytesDone, total: bytesTotal }
}

function formatByteProgress(done: number, total: number): string {
  const unit = total >= GB ? 'GB' : 'MB'
  const size = unit === 'GB' ? GB : MB
  return `${(done / size).toFixed(1)} ${unit} / ${(total / size).toFixed(1)} ${unit}`
}

function ratioPercent(done: number, total: number): number | undefined {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return undefined
  return Math.min(100, Math.max(0, (done / total) * 100))
}
