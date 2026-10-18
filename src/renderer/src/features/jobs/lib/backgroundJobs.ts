import { jobsCopy } from './jobsCopy'
import { connectorJobCopy } from './connectorJobCopy'
import type {
  BackgroundAgentJob,
  BackgroundShellJob
} from '../../../../../shared/backgroundJobTypes'
import type {
  EnvironmentBuild,
  EnvironmentBuildState
} from '../../../../../shared/environmentBuildTypes'
import type { RemoteProjectUploadJob } from '../../../../../shared/remoteProjectUploadTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import type { RemoteJupyterStartJob } from '../../../../../shared/remoteJupyterJobTypes'
import type { NotebookAiGenerationJob } from '../../../../../shared/notebookAiJobTypes'
import { canCancelBackgroundRun, resolveWrapperCancelTarget } from '../../wrapper/lib/wrapperView'
import type { RetainedBackgroundJob } from './backgroundJobHistory'

export type LiveBackgroundJob =
  | { kind: 'agent'; key: string; active: boolean; timestamp: string; run: BackgroundAgentJob }
  | {
      kind: 'upload'
      key: string
      active: boolean
      timestamp: string
      upload: RemoteProjectUploadJob
    }
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
  | { kind: 'jupyter'; key: string; active: boolean; timestamp: string; job: RemoteJupyterStartJob }
  | {
      kind: 'notebook-ai'
      key: string
      active: boolean
      timestamp: string
      job: NotebookAiGenerationJob
    }

export type UnifiedBackgroundJob = LiveBackgroundJob | RetainedBackgroundJob

export function notebookAiBackgroundJob(
  job: NotebookAiGenerationJob
): Extract<LiveBackgroundJob, { kind: 'notebook-ai' }> {
  return {
    kind: 'notebook-ai',
    key: `notebook-ai:${job.id}`,
    active: job.state === 'running',
    timestamp: job.completedAt ?? job.startedAt,
    job
  }
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
  get building() {
    return jobsCopy.building
  },
  get ready() {
    return jobsCopy.ready
  },
  get failed() {
    return jobsCopy.failed
  },
  get cancelled() {
    return jobsCopy.cancelled
  }
}

/** Labels for `EnsureProgressPhase`, plus `cancelled` which the build record sets on abort. */
const ENVIRONMENT_BUILD_PHASE_LABELS: Record<string, string> = {
  get check() {
    return jobsCopy.check
  },
  get wait() {
    return jobsCopy.waitingForPackageCache
  },
  get create() {
    return jobsCopy.downloadingPackages
  },
  get 'source-packages'() {
    return jobsCopy.installingSourcePackages
  },
  get activation() {
    return jobsCopy.activating
  },
  get finalize() {
    return jobsCopy.finishing
  },
  get done() {
    return jobsCopy.done
  },
  get failed() {
    return jobsCopy.failed
  },
  get cancelled() {
    return jobsCopy.cancelled
  }
}

const MB = 1024 ** 2
const GB = 1024 ** 3

export function canStopUnifiedWrapperRun(run: WrapperRun): boolean {
  if (canCancelBackgroundRun(run)) return true
  return resolveWrapperCancelTarget({ planId: run.planId, state: 'submitted' }, run)?.kind === 'run'
}

export function environmentBuildTitle(build: EnvironmentBuild): string {
  return jobsCopy.buildEnvironmentValue(build.ref)
}

export function environmentBuildDetail(build: EnvironmentBuild): string {
  const bytes = knownByteProgress(build)
  return [
    ENVIRONMENT_BUILD_STATE_LABELS[build.state],
    ENVIRONMENT_BUILD_PHASE_LABELS[build.phase] ?? build.phase,
    jobsCopy.valueValuePackages(build.progress.packagesDone, build.progress.packages),
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

/** Persisted jobs may contain the cancellation marker used before English resource UI. */
export function isCancelledConnectorJob(setup: McpConnectorSetupProgress): boolean {
  return setup.phase === 'failed' && (setup.error === 'Cancelled' || setup.error === '已取消')
}

export function connectorJobDetail(setup: McpConnectorSetupProgress, nowMs: number): string {
  if (setup.phase === 'ready') return connectorJobCopy.completedTools(setup.toolNames?.length ?? 0)
  if (isCancelledConnectorJob(setup)) return connectorJobCopy.cancelled
  if (setup.phase === 'failed') {
    if (setup.failureKind === 'needs-setup') {
      return `${connectorJobCopy.needsSetup}${setup.failureReason ? ` · ${setup.failureReason}` : ''}`
    }
    return `${connectorJobCopy.failed}${setup.error ? ` · ${setup.error}` : ''}`
  }
  return connectorJobCopy.starting(connectorJobDuration(setup, nowMs))
}

export function connectorJobStatusLabel(setup: McpConnectorSetupProgress): string {
  if (setup.phase === 'ready') return connectorJobCopy.completed
  if (isCancelledConnectorJob(setup)) return connectorJobCopy.cancelled
  if (setup.phase === 'failed' && setup.failureKind === 'needs-setup')
    return connectorJobCopy.needsSetup
  if (setup.phase === 'failed') return connectorJobCopy.failed
  return connectorJobCopy.inProgress
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
  connectors: readonly McpConnectorSetupProgress[] = [],
  uploads: readonly RemoteProjectUploadJob[] = [],
  jupyterJobs: readonly RemoteJupyterStartJob[] = [],
  notebookAiJobs: readonly NotebookAiGenerationJob[] = []
): { active: LiveBackgroundJob[]; recent: LiveBackgroundJob[] } {
  const maxRecent = query.maxRecent ?? 50
  const items: LiveBackgroundJob[] = [
    ...agents
      .filter((run) => run.background)
      .map((run): LiveBackgroundJob => ({
        kind: 'agent',
        key:
          run.canControl === false
            ? `agent:cold:${run.sessionId}:${run.agentRunId}`
            : `agent:${run.agentSessionId}:${run.agentRunId}`,
        active: run.canControl !== false && (run.state === 'queued' || run.state === 'running'),
        timestamp: run.completedAt ?? run.startedAt,
        run
      })),
    ...shells.map((run): LiveBackgroundJob => ({
      kind: 'shell',
      key: `shell:${run.agentSessionId}:${run.jobId}`,
      active: run.state === 'queued' || run.state === 'running',
      timestamp: run.completedAt ?? run.startedAt,
      run
    })),
    ...wrappers.map((run): LiveBackgroundJob => ({
      kind: 'wrapper',
      key: `wrapper:${run.runId}`,
      active: ACTIVE_WRAPPER_STATES.has(run.state),
      timestamp: run.completedAt ?? run.updatedAt,
      run
    })),
    ...environments.map((build): LiveBackgroundJob => ({
      kind: 'environment',
      key: `environment:${build.envId}`,
      active: build.state === 'building',
      timestamp: build.finishedAt ?? build.startedAt,
      build
    })),
    ...connectors
      .filter((setup) => setup.kind === 'local-stdio')
      .map((setup): LiveBackgroundJob => {
        const active = setup.phase === 'starting'
        return {
          kind: 'connector',
          key: `connector:${setup.id}`,
          active,
          timestamp: active ? (setup.startedAt ?? setup.updatedAt) : setup.updatedAt,
          setup
        }
      }),
    ...uploads.map((upload): LiveBackgroundJob => ({
      kind: 'upload',
      key: `upload:${upload.id}`,
      active: ['queued', 'uploading', 'verifying'].includes(upload.status),
      timestamp: new Date(upload.updatedAt).toISOString(),
      upload
    })),
    ...jupyterJobs.map((job): LiveBackgroundJob => ({
      kind: 'jupyter',
      key: `jupyter:${job.id}`,
      active: job.state === 'running',
      timestamp: job.finishedAt ?? job.startedAt,
      job
    })),
    ...notebookAiJobs.map(notebookAiBackgroundJob)
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

function belongsInFinishedTray(item: LiveBackgroundJob, query: BackgroundJobQuery): boolean {
  if (query.dismissedKeys?.has(item.key)) return false
  if (item.kind === 'agent' && item.run.historyAvailable === false) return true
  if (!query.finishedAfter) return true
  const endedAt =
    item.kind === 'environment'
      ? item.build.finishedAt
      : item.kind === 'connector'
        ? item.setup.updatedAt
        : item.kind === 'upload'
          ? item.timestamp
          : item.kind === 'jupyter'
            ? item.job.finishedAt
            : item.kind === 'notebook-ai'
              ? item.job.completedAt
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
