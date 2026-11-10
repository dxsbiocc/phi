import { getUiLocale } from '../../../lib/i18n'
import { jobsCopy } from './jobsCopy'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorJobCopy } from './connectorJobCopy'
import type {
  BackgroundAgentJob,
  BackgroundShellJob
} from '../../../../../shared/backgroundJobTypes'
import type {
  RemoteJupyterStartJob,
  RemoteJupyterStartJobTextParams
} from '../../../../../shared/remoteJupyterJobTypes'
import type { NotebookAiGenerationJob } from '../../../../../shared/notebookAiJobTypes'
import type { RemoteProjectUploadJob } from '../../../../../shared/remoteProjectUploadTypes'
import { formatAgentDuration } from '../../../lib/agentRunsOverview'
import { runProgressLabel, runStateLabel } from '../../wrapper/lib/wrapperView'
import { phiPluginDisplayTitle } from '../../phi-plugin/lib/phiPlugins'
import {
  canStopUnifiedWrapperRun,
  connectorJobDetail,
  isCancelledConnectorJob,
  environmentBuildDetail,
  environmentBuildPercent,
  type LiveBackgroundJob,
  type UnifiedBackgroundJob
} from './backgroundJobs'
import type { JobHistorySnapshot } from './backgroundJobHistory'

export type JobTone = 'running' | 'success' | 'error' | 'neutral'

export const JOB_TONE_COLOR: Record<JobTone, string> = {
  running: 'info.main',
  success: 'success.main',
  error: 'error.main',
  neutral: 'text.disabled'
}

export type JobDetailField = { label: string; value: string; mono?: boolean; scroll?: boolean }

type PluginInstall = Extract<UnifiedBackgroundJob, { kind: 'plugin' }>['install']

/** Name a plugin the same way the plugin list does, so 科研绘图 shows as Visualization. */
function pluginTitle(install: PluginInstall): string {
  return phiPluginDisplayTitle({ id: install.pluginId, title: install.title })
}

/** History saved before display names were applied still holds the raw registry title. */
function historyPluginTitle(key: string, title: string): string {
  return key.startsWith('plugin:')
    ? phiPluginDisplayTitle({ id: key.slice('plugin:'.length), title })
    : title
}

function pluginActionLabel(install: PluginInstall): string {
  return install.action === 'upgrade' ? jobsCopy.pluginUpgradeAction : jobsCopy.pluginInstallAction
}

/** A short, understandable sentence; raw failure detail stays in the main-process log. */
export function pluginInstallError(install: PluginInstall): string {
  return install.action === 'upgrade' ? jobsCopy.pluginUpgradeFailed : jobsCopy.pluginInstallFailed
}

type RemoteJupyterPhase = Pick<RemoteJupyterStartJob, 'phase'> & {
  phaseCode?: string
  phaseParams?: RemoteJupyterStartJobTextParams
}

type RemoteJupyterTextParams = RemoteJupyterStartJobTextParams | undefined

// Built at render time so a language switch relabels existing jobs.
const REMOTE_JUPYTER_TEXT: Record<string, (params: RemoteJupyterTextParams) => string> = {
  preparing: () => jobsCopy.remoteJupyterPreparing,
  connecting: (params) => jobsCopy.remoteJupyterConnecting(params?.serverLabel),
  checking_configured_jupyter: (params) =>
    jobsCopy.remoteJupyterCheckingConfiguredPath(params?.configuredPath),
  checking_server_path_jupyter: () => jobsCopy.remoteJupyterCheckingServerPath,
  missing_jupyter_using_managed: (params) =>
    jobsCopy.remoteJupyterMissingUsingManaged(params?.environmentRef),
  using_existing_jupyter: (params) =>
    jobsCopy.remoteJupyterUsingExisting(params?.jupyterPath, params?.version, params?.pythonPath),
  using_managed_jupyter: (params) => jobsCopy.remoteJupyterUsingManaged(params?.jupyterPath),
  allocating_ports: () => jobsCopy.remoteJupyterAllocatingPorts,
  starting_lease: () => jobsCopy.remoteJupyterStartingLease,
  probing_through_tunnel: () => jobsCopy.remoteJupyterProbingThroughTunnel,
  ready: () => jobsCopy.remoteJupyterReady,
  cleaning: () => jobsCopy.remoteJupyterCleaning,
  reconciling: () => jobsCopy.remoteJupyterReconciling,
  disconnected: () => jobsCopy.remoteJupyterDisconnected
}

const REMOTE_JUPYTER_PHASE_ONLY: Record<string, () => string> = {
  failed: () => jobsCopy.remoteJupyterFailed,
  cancelled: () => jobsCopy.remoteJupyterCancelled
}

const REMOTE_JUPYTER_ENTRY_ONLY: Record<string, () => string> = {
  startup_cancelled: () => jobsCopy.remoteJupyterStartupCancelled
}

export function remoteJupyterPhaseLabel(job: RemoteJupyterPhase): string {
  const code = job.phaseCode ?? ''
  if (Object.hasOwn(REMOTE_JUPYTER_PHASE_ONLY, code)) return REMOTE_JUPYTER_PHASE_ONLY[code]()
  if (Object.hasOwn(REMOTE_JUPYTER_TEXT, code)) return REMOTE_JUPYTER_TEXT[code](job.phaseParams)
  return job.phase
}

export function remoteJupyterEntryLabel(
  entry: Pick<RemoteJupyterStartJob['entries'][number], 'at' | 'kind' | 'text'> & {
    code?: string
    params?: RemoteJupyterStartJobTextParams
  }
): string {
  // Server stdout/stderr is user data, even if a future producer accidentally attaches a code.
  if (entry.kind === 'output') return entry.text
  const code = entry.code ?? ''
  const format = Object.hasOwn(REMOTE_JUPYTER_ENTRY_ONLY, code)
    ? REMOTE_JUPYTER_ENTRY_ONLY[code]
    : code !== 'preparing' && Object.hasOwn(REMOTE_JUPYTER_TEXT, code)
      ? REMOTE_JUPYTER_TEXT[code]
      : undefined
  if (!format) return entry.text
  const label = format(entry.params)
  return entry.params?.detail ? `${label}: ${entry.params.detail}` : label
}

const AGENT_STATE_LABELS = {
  get queued() {
    return jobsCopy.queued
  },
  get running() {
    return jobsCopy.running
  },
  get done() {
    return jobsCopy.completed
  },
  get error() {
    return jobsCopy.failed
  },
  get cancelled() {
    return jobsCopy.stopped
  },
  get interrupted() {
    return jobsCopy.interrupted
  }
} satisfies Record<BackgroundAgentJob['state'], string>

const SHELL_STATE_LABELS = {
  get queued() {
    return jobsCopy.queued
  },
  get running() {
    return jobsCopy.running
  },
  get completed() {
    return jobsCopy.completed
  },
  get failed() {
    return jobsCopy.failed
  },
  get cancelled() {
    return jobsCopy.stopped
  },
  get interrupted() {
    return jobsCopy.interrupted
  }
} satisfies Record<BackgroundShellJob['state'], string>

const UPLOAD_STATE_LABELS: Record<RemoteProjectUploadJob['status'], string> = {
  get queued() {
    return jobsCopy.queue
  },
  get uploading() {
    return jobsCopy.uploading
  },
  get verifying() {
    return jobsCopy.verifying
  },
  get completed() {
    return jobsCopy.done
  },
  get failed() {
    return jobsCopy.failed
  },
  get cancelled() {
    return jobsCopy.cancelled
  }
}

const JUPYTER_STATE_LABELS: Record<RemoteJupyterStartJob['state'], string> = {
  get running() {
    return jobsCopy.starting
  },
  get ready() {
    return jobsCopy.ready
  },
  get failed() {
    return jobsCopy.startupFailed
  },
  get cancelled() {
    return jobsCopy.stopped
  }
}

const NOTEBOOK_AI_PHASE_LABELS: Record<NotebookAiGenerationJob['phase'], string> = {
  get preparing() {
    return jobsCopy.preparingContext
  },
  get waiting() {
    return jobsCopy.awaitingModelResponse
  },
  get generating() {
    return jobsCopy.generatingCode
  },
  get repairing() {
    return jobsCopy.repairingGeneratedOutput
  },
  get completed() {
    return jobsCopy.completed
  },
  get failed() {
    return jobsCopy.generationFailed
  }
}

function uploadTitle(upload: RemoteProjectUploadJob): string {
  const first = upload.files[0]?.name ?? jobsCopy.localFile
  return upload.totalFiles > 1
    ? jobsCopy.valueAndValueFilesInTotal(first, upload.totalFiles)
    : first
}

function uploadDetail(upload: RemoteProjectUploadJob): string {
  const renamed = upload.files.find((file) => file.resolution === 'renamed')
  const totalMiB = upload.totalBytes / 1024 ** 2
  const transferredMiB = upload.bytesTransferred / 1024 ** 2
  return [
    UPLOAD_STATE_LABELS[upload.status],
    `${transferredMiB.toFixed(1)} / ${totalMiB.toFixed(1)} MiB`,
    upload.bytesPerSecond > 0
      ? `${(upload.bytesPerSecond / 1024 ** 2).toFixed(1)} MiB/s`
      : undefined,
    renamed?.destinationPath
      ? jobsCopy.duplicateFilenameRenamedToValue(
          renamed.destinationPath.split('/').pop() ?? renamed.destinationPath
        )
      : undefined,
    upload.error
  ]
    .filter(Boolean)
    .join(' · ')
}

export function uploadPercent(upload: RemoteProjectUploadJob): number | undefined {
  if (upload.totalBytes <= 0) return undefined
  return Math.min(100, Math.max(0, (upload.bytesTransferred / upload.totalBytes) * 100))
}

export function jobPercent(item: UnifiedBackgroundJob): number | undefined {
  if (item.kind === 'environment') return environmentBuildPercent(item.build)
  if (item.kind === 'upload') return uploadPercent(item.upload)
  return undefined
}

/**
 * History saved before the card showed its operation on the second line kept
 * the operation in the title ("启动 Jupyter Server · demo"); drop it so the
 * card does not say it twice.
 */
const LEGACY_TITLE_PREFIXES: Partial<Record<LiveBackgroundJob['kind'], readonly string[]>> = {
  jupyter: ['Start Jupyter Server · ', '启动 Jupyter Server · '],
  'notebook-ai': ['AI generation · ', 'AI 生成 · '],
  environment: ['Build environment ', '构建环境 ']
}

function historyTitle(snapshot: JobHistorySnapshot): string {
  const prefix = LEGACY_TITLE_PREFIXES[snapshot.sourceKind]?.find(
    (candidate) => snapshot.title.startsWith(candidate) && snapshot.title.length > candidate.length
  )
  return prefix
    ? snapshot.title.slice(prefix.length)
    : historyPluginTitle(snapshot.key, snapshot.title)
}

export function jobTitle(item: UnifiedBackgroundJob): string {
  if (item.kind === 'history') return historyTitle(item.snapshot)
  if (item.kind === 'connector') return item.setup.title ?? item.setup.id
  if (item.kind === 'environment') return item.build.ref
  if (item.kind === 'upload') return uploadTitle(item.upload)
  if (item.kind === 'jupyter') return item.job.projectName
  if (item.kind === 'notebook-ai') return item.job.notebookName
  if (item.kind === 'plugin') return pluginTitle(item.install)
  if (item.kind === 'agent') return item.run.agentName
  if (item.kind === 'shell') return item.run.command
  return (
    item.run.workflow?.step ||
    item.run.runName ||
    item.run.wrapper.shortId ||
    item.run.wrapper.canonicalId
  )
}

export function jobSource(item: UnifiedBackgroundJob): string {
  if (item.kind === 'history') return item.snapshot.source
  if (item.kind === 'connector') return resourceUi.connector
  if (item.kind === 'environment') return jobsCopy.environment
  if (item.kind === 'upload') return jobsCopy.upload
  if (item.kind === 'wrapper') return 'Wrapper'
  if (item.kind === 'jupyter') return jobsCopy.remoteJupyter
  if (item.kind === 'notebook-ai') return 'Notebook AI'
  if (item.kind === 'plugin') return jobsCopy.plugin
  return item.run.sessionTitle
}

const OPERATION_LABELS: Record<Exclude<LiveBackgroundJob['kind'], 'plugin'>, () => string> = {
  agent: () => jobsCopy.operationDispatchSubagent,
  shell: () => jobsCopy.operationRunCommand,
  wrapper: () => jobsCopy.operationRunWrapper,
  environment: () => jobsCopy.operationBuildEnvironment,
  connector: () => jobsCopy.operationSetUpConnector,
  upload: () => jobsCopy.operationUploadFiles,
  jupyter: () => jobsCopy.operationStartJupyter,
  'notebook-ai': () => jobsCopy.operationGenerateNotebookCode
}

/** Saved plugin jobs keep the action as a detail field ("操作: 升级"), in either UI language. */
const UPGRADE_ACTION_VALUES = new Set(['Upgrade', '升级'])
const VERSION_FIELD_LABELS = new Set(['Version', '版本'])

function historyField(snapshot: JobHistorySnapshot, labels: Set<string>): string | undefined {
  return snapshot.fields.find((field) => labels.has(field.label))?.value || undefined
}

function pluginOperation(action: PluginInstall['action']): string {
  return action === 'upgrade' ? jobsCopy.operationUpgradePlugin : jobsCopy.operationInstallPlugin
}

/** What the job does, such as 安装插件 or 派发子智能体. */
export function jobOperation(item: UnifiedBackgroundJob): string {
  if (item.kind === 'plugin') return pluginOperation(item.install.action)
  if (item.kind !== 'history') return OPERATION_LABELS[item.kind]()
  const { snapshot } = item
  if (snapshot.sourceKind !== 'plugin') return OPERATION_LABELS[snapshot.sourceKind]()
  const upgraded = snapshot.fields.some((field) => UPGRADE_ACTION_VALUES.has(field.value))
  return pluginOperation(upgraded ? 'upgrade' : 'install')
}

/** The object the operation acted on, when the title does not already name it. */
function operationTarget(item: UnifiedBackgroundJob): string | undefined {
  if (item.kind === 'history')
    return item.snapshot.sourceKind === 'plugin'
      ? historyField(item.snapshot, VERSION_FIELD_LABELS)
      : undefined
  if (item.kind === 'plugin') return item.install.version || undefined
  if (item.kind === 'agent') return item.run.task || undefined
  if (item.kind === 'upload') return item.upload.destinationDirectory || jobsCopy.projectRoot
  if (item.kind === 'jupyter') return item.job.serverLabel || undefined
  return undefined
}

/** Second line of a job card: the operation, then its target, e.g. "安装插件 · 0.7.0". */
export function jobSubtitle(item: UnifiedBackgroundJob): string {
  return [jobOperation(item), operationTarget(item)].filter(Boolean).join(' · ')
}

function elapsed(
  startedAt: string | undefined,
  endedAt: string | undefined,
  nowMs: number
): string {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN
  if (!Number.isFinite(startedMs)) return ''
  const endedMs = endedAt ? Date.parse(endedAt) : nowMs
  return formatAgentDuration(Math.max(0, (Number.isFinite(endedMs) ? endedMs : nowMs) - startedMs))
}

/** One line for the list row. */
export function jobDetail(item: UnifiedBackgroundJob, nowMs: number): string {
  if (item.kind === 'history') return item.snapshot.status.label
  if (item.kind === 'connector') return connectorJobDetail(item.setup, nowMs)
  if (item.kind === 'environment') return environmentBuildDetail(item.build)
  if (item.kind === 'upload') return uploadDetail(item.upload)
  if (item.kind === 'plugin') {
    return [
      pluginActionLabel(item.install),
      item.install.version ? `v${item.install.version}` : undefined,
      item.install.state === 'running'
        ? jobsCopy.inProgress
        : item.install.state === 'succeeded'
          ? jobsCopy.completed
          : jobsCopy.failed,
      item.install.state === 'failed' ? pluginInstallError(item.install) : undefined
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (item.kind === 'notebook-ai') {
    return [
      NOTEBOOK_AI_PHASE_LABELS[item.job.phase],
      elapsed(item.job.startedAt, item.job.completedAt, nowMs),
      item.job.cellCount === undefined ? undefined : jobsCopy.valueCells(item.job.cellCount),
      item.job.state === 'failed' ? item.job.error : undefined
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (item.kind === 'jupyter') {
    return [
      JUPYTER_STATE_LABELS[item.job.state],
      item.job.state === 'failed' ? item.job.error : remoteJupyterPhaseLabel(item.job)
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (item.kind === 'wrapper') {
    return [runStateLabel(item.run.state), runProgressLabel(item.run)].filter(Boolean).join(' · ')
  }
  const duration = item.active ? elapsed(item.run.startedAt, undefined, nowMs) : undefined
  if (item.kind === 'shell') {
    return [SHELL_STATE_LABELS[item.run.state], duration, item.run.output]
      .filter(Boolean)
      .join(' · ')
  }
  return [
    AGENT_STATE_LABELS[item.run.state],
    item.run.historyAvailable === false
      ? jobsCopy.recordFromAnOldConnectionNotRestartedAutomatically
      : undefined,
    duration,
    item.run.lastStep,
    item.run.toolCalls ? jobsCopy.valueSteps(item.run.toolCalls) : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}

export function jobStatus(item: UnifiedBackgroundJob): { label: string; tone: JobTone } {
  if (item.kind === 'history') return item.snapshot.status
  if (item.active) {
    if (item.kind === 'jupyter') return { label: JUPYTER_STATE_LABELS.running, tone: 'running' }
    if (item.kind === 'connector') return { label: connectorJobCopy.inProgress, tone: 'running' }
    return { label: jobsCopy.inProgress, tone: 'running' }
  }
  const failed = (label: string): { label: string; tone: JobTone } => ({ label, tone: 'error' })
  const done = (label: string): { label: string; tone: JobTone } => ({ label, tone: 'success' })
  const stopped = (label: string): { label: string; tone: JobTone } => ({ label, tone: 'neutral' })
  switch (item.kind) {
    case 'notebook-ai':
      return item.job.state === 'completed'
        ? done(jobsCopy.completed)
        : failed(jobsCopy.generationFailed)
    case 'jupyter':
      if (item.job.state === 'ready') return done(JUPYTER_STATE_LABELS.ready)
      if (item.job.state === 'failed') return failed(JUPYTER_STATE_LABELS.failed)
      return stopped(JUPYTER_STATE_LABELS.cancelled)
    case 'agent':
      if (item.run.state === 'done') return done(AGENT_STATE_LABELS.done)
      if (item.run.state === 'error') return failed(AGENT_STATE_LABELS.error)
      return stopped(AGENT_STATE_LABELS[item.run.state])
    case 'shell':
      if (item.run.state === 'completed') return done(SHELL_STATE_LABELS.completed)
      if (item.run.state === 'failed') return failed(SHELL_STATE_LABELS.failed)
      return stopped(SHELL_STATE_LABELS[item.run.state])
    case 'wrapper':
      if (item.run.state === 'completed') return done(runStateLabel(item.run.state))
      if (item.run.state === 'failed' || item.run.state === 'lost') {
        return failed(runStateLabel(item.run.state))
      }
      return stopped(runStateLabel(item.run.state))
    case 'environment':
      if (item.build.state === 'ready') return done(jobsCopy.ready)
      if (item.build.state === 'failed') return failed(jobsCopy.failed)
      return stopped(jobsCopy.cancelled)
    case 'upload':
      if (item.upload.status === 'completed') return done(UPLOAD_STATE_LABELS.completed)
      if (item.upload.status === 'failed') return failed(UPLOAD_STATE_LABELS.failed)
      return stopped(UPLOAD_STATE_LABELS[item.upload.status])
    case 'connector':
      if (item.setup.phase === 'ready') return done(connectorJobCopy.completed)
      if (isCancelledConnectorJob(item.setup)) return stopped(connectorJobCopy.cancelled)
      return failed(
        item.setup.failureKind === 'needs-setup'
          ? connectorJobCopy.needsSetup
          : connectorJobCopy.failed
      )
    case 'plugin':
      return item.install.state === 'succeeded' ? done(jobsCopy.completed) : failed(jobsCopy.failed)
  }
}

export function canStopJob(item: UnifiedBackgroundJob): boolean {
  if (item.kind === 'history') return false
  if (item.kind === 'agent' && item.run.canControl === false) return false
  if (item.kind === 'wrapper') return canStopUnifiedWrapperRun(item.run)
  // A Jupyter start is stopped from the runtime card, which owns the project binding.
  if (item.kind === 'jupyter') return false
  if (item.kind === 'notebook-ai') return false
  // Plugin installs cannot be cancelled; the main process owns the attempt.
  if (item.kind === 'plugin') return false
  return item.active
}

export function stopTooltip(item: UnifiedBackgroundJob): string {
  if (item.kind === 'connector') return connectorJobCopy.cancelAdd
  if (item.kind === 'environment') return jobsCopy.cancelBuild
  if (item.kind === 'upload') return jobsCopy.cancelUpload
  if (item.kind === 'agent') return jobsCopy.stopThisAgent
  if (item.kind === 'shell') return jobsCopy.stopThisBackgroundCommand
  return jobsCopy.cancelThisWrapperRun
}

export function stopAriaLabel(item: UnifiedBackgroundJob): string {
  const title = jobTitle(item)
  if (item.kind === 'environment') return jobsCopy.cancelBuild
  if (item.kind === 'upload') return jobsCopy.cancelUploadValue(title)
  if (item.kind === 'connector') return connectorJobCopy.cancelNamed(title)
  return jobsCopy.stopValue(title)
}

function timeLabel(value: string | number | undefined): string {
  if (value === undefined) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(getUiLocale())
}

/** Fields of the in-panel detail view. Connector and Jupyter jobs add their own sections. */
export function jobDetailFields(item: UnifiedBackgroundJob, nowMs: number): JobDetailField[] {
  if (item.kind === 'history') {
    return item.snapshot.fields.map((field) => ({
      ...field,
      value: historyPluginTitle(item.snapshot.key, field.value)
    }))
  }
  const status = jobStatus(item).label
  const fields: Array<JobDetailField | undefined> = (() => {
    switch (item.kind) {
      case 'notebook-ai':
        return [
          { label: 'Notebook', value: item.job.notebookPath || item.job.notebookName },
          { label: jobsCopy.project, value: item.job.projectCwd },
          { label: jobsCopy.model, value: item.job.model },
          { label: jobsCopy.status, value: status },
          item.job.cellCount === undefined
            ? undefined
            : { label: jobsCopy.generatedCells, value: jobsCopy.valueCells(item.job.cellCount) },
          { label: jobsCopy.started, value: timeLabel(item.job.startedAt) },
          {
            label: jobsCopy.duration,
            value: elapsed(item.job.startedAt, item.job.completedAt, nowMs)
          },
          item.job.completedAt
            ? { label: jobsCopy.finished, value: timeLabel(item.job.completedAt) }
            : undefined,
          { label: jobsCopy.currentStep, value: NOTEBOOK_AI_PHASE_LABELS[item.job.phase] },
          { label: jobsCopy.request, value: item.job.prompt },
          item.job.sourcePreview
            ? {
                label: jobsCopy.generatedContentPreview,
                value: item.job.sourcePreview,
                mono: true,
                scroll: true
              }
            : undefined,
          item.job.error ? { label: jobsCopy.error, value: item.job.error, mono: true } : undefined
        ]
      case 'agent':
        return [
          { label: jobsCopy.conversation, value: item.run.sessionTitle },
          { label: jobsCopy.task, value: item.run.task },
          { label: jobsCopy.status, value: status },
          item.run.historyAvailable === false
            ? {
                label: jobsCopy.description,
                value: jobsCopy.taskRecordFromAnOldConnectionExecutionHistoryIsUnavailable
              }
            : undefined,
          { label: jobsCopy.started, value: timeLabel(item.run.startedAt) },
          {
            label: jobsCopy.duration,
            value: elapsed(item.run.startedAt, item.run.completedAt, nowMs)
          },
          item.run.lastStep ? { label: jobsCopy.lastStep, value: item.run.lastStep } : undefined,
          item.run.toolCalls
            ? { label: jobsCopy.toolCall, value: jobsCopy.valueSteps(item.run.toolCalls) }
            : undefined
        ]
      case 'shell':
        return [
          { label: jobsCopy.conversation, value: item.run.sessionTitle },
          { label: jobsCopy.command, value: item.run.command, mono: true },
          { label: jobsCopy.status, value: status },
          { label: jobsCopy.started, value: timeLabel(item.run.startedAt) },
          {
            label: jobsCopy.duration,
            value: elapsed(item.run.startedAt, item.run.completedAt, nowMs)
          },
          {
            label: jobsCopy.output,
            value: item.run.output || jobsCopy.noOutput,
            mono: true,
            scroll: true
          }
        ]
      case 'wrapper':
        return [
          { label: 'Wrapper', value: item.run.wrapper.canonicalId },
          { label: jobsCopy.runID, value: item.run.runId, mono: true },
          { label: jobsCopy.status, value: status },
          item.run.remote ? { label: jobsCopy.server, value: item.run.remote.host } : undefined,
          ['slurm', 'slurm-controller'].includes(item.run.executor)
            ? { label: jobsCopy.scheduler, value: 'Slurm' }
            : undefined,
          runProgressLabel(item.run)
            ? { label: jobsCopy.progress, value: runProgressLabel(item.run) ?? '' }
            : undefined,
          { label: jobsCopy.started, value: timeLabel(item.run.startedAt ?? item.run.createdAt) },
          {
            label: jobsCopy.duration,
            value: elapsed(item.run.startedAt ?? item.run.createdAt, item.run.completedAt, nowMs)
          },
          { label: jobsCopy.outputDirectory, value: item.run.outDir },
          item.run.environmentError
            ? { label: jobsCopy.environmentError, value: item.run.environmentError, mono: true }
            : undefined,
          item.run.inputErrors?.length
            ? { label: jobsCopy.inputError, value: item.run.inputErrors.join('\n'), mono: true }
            : undefined,
          item.run.launchDiagnostic
            ? { label: jobsCopy.startupDiagnostics, value: item.run.launchDiagnostic, mono: true }
            : undefined
        ]
      case 'environment':
        return [
          { label: jobsCopy.environment, value: item.build.ref },
          { label: jobsCopy.environmentID, value: item.build.envId, mono: true },
          { label: jobsCopy.status, value: status },
          { label: jobsCopy.progress, value: environmentBuildDetail(item.build) },
          { label: jobsCopy.started, value: timeLabel(item.build.startedAt) },
          {
            label: jobsCopy.duration,
            value: elapsed(item.build.startedAt, item.build.finishedAt, nowMs)
          },
          item.build.message
            ? { label: jobsCopy.description, value: item.build.message }
            : undefined,
          item.build.error
            ? { label: jobsCopy.error, value: item.build.error, mono: true }
            : undefined
        ]
      case 'upload':
        return [
          { label: jobsCopy.file, value: item.upload.files.map((file) => file.name).join('\n') },
          {
            label: jobsCopy.destinationDirectory,
            value: item.upload.destinationDirectory || jobsCopy.projectRoot
          },
          { label: jobsCopy.status, value: status },
          { label: jobsCopy.progress, value: uploadDetail(item.upload) },
          { label: jobsCopy.started, value: timeLabel(item.upload.createdAt) },
          item.upload.error
            ? { label: jobsCopy.error, value: item.upload.error, mono: true }
            : undefined
        ]
      case 'plugin':
        return [
          { label: jobsCopy.plugin, value: pluginTitle(item.install) },
          { label: jobsCopy.pluginVersion, value: item.install.version },
          { label: jobsCopy.pluginJobAction, value: pluginActionLabel(item.install) },
          { label: jobsCopy.status, value: status },
          { label: jobsCopy.started, value: timeLabel(item.install.startedAt) },
          {
            label: jobsCopy.duration,
            value: elapsed(item.install.startedAt, item.install.finishedAt, nowMs)
          },
          item.install.finishedAt
            ? { label: jobsCopy.finished, value: timeLabel(item.install.finishedAt) }
            : undefined,
          item.install.state === 'failed'
            ? { label: jobsCopy.pluginFailureLabel, value: pluginInstallError(item.install) }
            : undefined
        ]
      case 'jupyter':
        return [
          { label: jobsCopy.project, value: item.job.projectName },
          { label: jobsCopy.server, value: item.job.serverLabel },
          { label: jobsCopy.status, value: status },
          { label: jobsCopy.currentStep, value: remoteJupyterPhaseLabel(item.job) },
          { label: jobsCopy.started, value: timeLabel(item.job.startedAt) },
          {
            label: jobsCopy.duration,
            value: elapsed(item.job.startedAt, item.job.finishedAt, nowMs)
          },
          item.job.error ? { label: jobsCopy.error, value: item.job.error, mono: true } : undefined
        ]
      case 'connector':
        return []
    }
  })()
  return fields.filter(
    (field): field is JobDetailField => field !== undefined && field.value !== ''
  )
}
