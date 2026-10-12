import type {
  BackgroundAgentJob,
  BackgroundShellJob
} from '../../../../../shared/backgroundJobTypes'
import type {
  EnvironmentBuild,
  EnvironmentBuildState
} from '../../../../../shared/environmentBuildTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { canCancelBackgroundRun, resolveWrapperCancelTarget } from '../../wrapper/lib/wrapperView'

export type UnifiedBackgroundJob =
  | { kind: 'agent'; key: string; active: boolean; timestamp: string; run: BackgroundAgentJob }
  | { kind: 'shell'; key: string; active: boolean; timestamp: string; run: BackgroundShellJob }
  | { kind: 'wrapper'; key: string; active: boolean; timestamp: string; run: WrapperRun }
  | {
      kind: 'environment'
      key: string
      active: boolean
      timestamp: string
      build: EnvironmentBuild
    }
  | {
      kind: 'connector'
      key: string
      active: boolean
      timestamp: string
      setup: McpConnectorSetupProgress
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

export function connectorJobDetail(setup: McpConnectorSetupProgress, nowMs: number): string {
  if (setup.phase === 'ready') return `已完成 · ${setup.toolNames?.length ?? 0} 个工具`
  if (setup.phase === 'failed') {
    if (setup.failureKind === 'needs-setup') {
      return `需要先配置${setup.failureReason ? ` · ${setup.failureReason}` : ''}`
    }
    return setup.error === '已取消' ? '已取消' : `失败${setup.error ? ` · ${setup.error}` : ''}`
  }
  return `正在启动并验证 · 已用时 ${connectorJobDuration(setup, nowMs)}`
}

export function connectorJobStatusLabel(setup: McpConnectorSetupProgress): string {
  if (setup.phase === 'ready') return '已完成'
  if (setup.phase === 'failed' && setup.failureKind === 'needs-setup') return '需要先配置'
  if (setup.phase === 'failed') return setup.error === '已取消' ? '已取消' : '失败'
  return '进行中'
}

export function connectorJobDuration(setup: McpConnectorSetupProgress, nowMs: number): string {
  const startedAtMs = setup.startedAt ? Date.parse(setup.startedAt) : Number.NaN
  if (!Number.isFinite(startedAtMs)) return '00:00'
  const endMs = setup.phase === 'starting' ? nowMs : Date.parse(setup.updatedAt)
  return formatClockDuration(Math.max(0, (Number.isFinite(endMs) ? endMs : nowMs) - startedAtMs))
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
  shells: readonly BackgroundShellJob[] = [],
  environments: readonly EnvironmentBuild[] = [],
  connectors: readonly McpConnectorSetupProgress[] = []
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
    })),
    ...environments.map((build): UnifiedBackgroundJob => ({
      kind: 'environment',
      key: `environment:${build.envId}`,
      active: build.state === 'building',
      timestamp: build.finishedAt ?? build.startedAt,
      build
    })),
    ...connectors
      .filter((setup) => setup.kind === 'local-stdio')
      .map((setup): UnifiedBackgroundJob => {
        const active = setup.phase === 'starting'
        return {
          kind: 'connector',
          key: `connector:${setup.id}`,
          active,
          timestamp: active ? (setup.startedAt ?? setup.updatedAt) : setup.updatedAt,
          setup
        }
      })
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
  const endedAt =
    item.kind === 'environment'
      ? item.build.finishedAt
      : item.kind === 'connector'
        ? item.setup.updatedAt
        : item.run.completedAt
  return Boolean(endedAt && endedAt >= query.finishedAfter)
}

function formatClockDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
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
