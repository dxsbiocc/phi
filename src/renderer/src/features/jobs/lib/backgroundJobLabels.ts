import type {
  BackgroundAgentJob,
  BackgroundShellJob
} from '../../../../../shared/backgroundJobTypes'
import type { RemoteJupyterStartJob } from '../../../../../shared/remoteJupyterJobTypes'
import type { NotebookAiGenerationJob } from '../../../../../shared/notebookAiJobTypes'
import type { RemoteProjectUploadJob } from '../../../../../shared/remoteProjectUploadTypes'
import { formatAgentDuration } from '../../../lib/agentRunsOverview'
import { runProgressLabel, runStateLabel } from '../../wrapper/lib/wrapperView'
import {
  canStopUnifiedWrapperRun,
  connectorJobDetail,
  environmentBuildDetail,
  environmentBuildPercent,
  environmentBuildTitle,
  type UnifiedBackgroundJob
} from './backgroundJobs'

export type JobTone = 'running' | 'success' | 'error' | 'neutral'

export const JOB_TONE_COLOR: Record<JobTone, string> = {
  running: 'info.main',
  success: 'success.main',
  error: 'error.main',
  neutral: 'text.disabled'
}

export type JobDetailField = { label: string; value: string; mono?: boolean; scroll?: boolean }

const AGENT_STATE_LABELS = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  error: '失败',
  cancelled: '已停止',
  interrupted: '已中断'
} satisfies Record<BackgroundAgentJob['state'], string>

const SHELL_STATE_LABELS = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止'
} satisfies Record<BackgroundShellJob['state'], string>

const UPLOAD_STATE_LABELS: Record<RemoteProjectUploadJob['status'], string> = {
  queued: '排队',
  uploading: '上传中',
  verifying: '校验',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消'
}

const JUPYTER_STATE_LABELS: Record<RemoteJupyterStartJob['state'], string> = {
  running: '启动中',
  ready: '已就绪',
  failed: '启动失败',
  cancelled: '已停止'
}

const NOTEBOOK_AI_PHASE_LABELS: Record<NotebookAiGenerationJob['phase'], string> = {
  preparing: '准备上下文',
  waiting: '等待模型响应',
  generating: '正在生成代码',
  repairing: '修正生成结果',
  completed: '已完成',
  failed: '生成失败'
}

function uploadTitle(upload: RemoteProjectUploadJob): string {
  const first = upload.files[0]?.name ?? '本机文件'
  return upload.totalFiles > 1 ? `${first} 等 ${upload.totalFiles} 个文件` : first
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
      ? `同名文件已改为 ${renamed.destinationPath.split('/').pop()}`
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

export function jobTitle(item: UnifiedBackgroundJob): string {
  if (item.kind === 'history') return item.snapshot.title
  if (item.kind === 'connector') return item.setup.title ?? item.setup.id
  if (item.kind === 'environment') return environmentBuildTitle(item.build)
  if (item.kind === 'upload') return uploadTitle(item.upload)
  if (item.kind === 'jupyter') return `启动 Jupyter Server · ${item.job.projectName}`
  if (item.kind === 'notebook-ai') return `AI 生成 · ${item.job.notebookName}`
  if (item.kind === 'agent') return item.run.agentName
  if (item.kind === 'shell') return item.run.command
  return item.run.runName || item.run.wrapper.shortId || item.run.wrapper.canonicalId
}

export function jobSource(item: UnifiedBackgroundJob): string {
  if (item.kind === 'history') return item.snapshot.source
  if (item.kind === 'connector') return '连接器'
  if (item.kind === 'environment') return '环境'
  if (item.kind === 'upload') return '上传'
  if (item.kind === 'wrapper') return 'Wrapper'
  if (item.kind === 'jupyter') return '远程 Jupyter'
  if (item.kind === 'notebook-ai') return 'Notebook AI'
  return item.run.sessionTitle
}

export function jobSubtitle(item: UnifiedBackgroundJob): string {
  if (item.kind === 'history') return '历史记录'
  if (item.kind === 'connector') return item.setup.summary ?? item.setup.id
  if (item.kind === 'environment') return item.build.envId
  if (item.kind === 'upload') return item.upload.destinationDirectory || '项目根目录'
  if (item.kind === 'jupyter') return item.job.serverLabel
  if (item.kind === 'notebook-ai') return item.job.projectCwd
  if (item.kind === 'agent') return item.run.task
  if (item.kind === 'shell') return '后台命令'
  return item.run.runId
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
  if (item.kind === 'notebook-ai') {
    return [
      NOTEBOOK_AI_PHASE_LABELS[item.job.phase],
      elapsed(item.job.startedAt, item.job.completedAt, nowMs),
      item.job.cellCount === undefined ? undefined : `${item.job.cellCount} 个单元`,
      item.job.state === 'failed' ? item.job.error : undefined
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (item.kind === 'jupyter') {
    return [
      JUPYTER_STATE_LABELS[item.job.state],
      item.job.state === 'failed' ? item.job.error : item.job.phase
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
    item.run.historyAvailable === false ? '旧连接的记录，未自动重启' : undefined,
    duration,
    item.run.lastStep,
    item.run.toolCalls ? `${item.run.toolCalls} 步` : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}

export function jobStatus(item: UnifiedBackgroundJob): { label: string; tone: JobTone } {
  if (item.kind === 'history') return item.snapshot.status
  if (item.active) {
    if (item.kind === 'jupyter') return { label: JUPYTER_STATE_LABELS.running, tone: 'running' }
    return { label: '进行中', tone: 'running' }
  }
  const failed = (label: string): { label: string; tone: JobTone } => ({ label, tone: 'error' })
  const done = (label: string): { label: string; tone: JobTone } => ({ label, tone: 'success' })
  const stopped = (label: string): { label: string; tone: JobTone } => ({ label, tone: 'neutral' })
  switch (item.kind) {
    case 'notebook-ai':
      return item.job.state === 'completed' ? done('已完成') : failed('生成失败')
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
      if (item.build.state === 'ready') return done('已就绪')
      if (item.build.state === 'failed') return failed('失败')
      return stopped('已取消')
    case 'upload':
      if (item.upload.status === 'completed') return done(UPLOAD_STATE_LABELS.completed)
      if (item.upload.status === 'failed') return failed(UPLOAD_STATE_LABELS.failed)
      return stopped(UPLOAD_STATE_LABELS[item.upload.status])
    case 'connector':
      if (item.setup.phase === 'ready') return done('已完成')
      if (item.setup.error === '已取消') return stopped('已取消')
      return failed(item.setup.failureKind === 'needs-setup' ? '需要先配置' : '失败')
  }
}

export function canStopJob(item: UnifiedBackgroundJob): boolean {
  if (item.kind === 'history') return false
  if (item.kind === 'agent' && item.run.canControl === false) return false
  if (item.kind === 'wrapper') return canStopUnifiedWrapperRun(item.run)
  // A Jupyter start is stopped from the runtime card, which owns the project binding.
  if (item.kind === 'jupyter') return false
  if (item.kind === 'notebook-ai') return false
  return item.active
}

export function stopTooltip(item: UnifiedBackgroundJob): string {
  if (item.kind === 'connector') return '取消添加'
  if (item.kind === 'environment') return '取消构建'
  if (item.kind === 'upload') return '取消上传'
  if (item.kind === 'agent') return '停止这个 Agent'
  if (item.kind === 'shell') return '停止这个后台命令'
  return '取消这个 Wrapper 运行'
}

export function stopAriaLabel(item: UnifiedBackgroundJob): string {
  const title = jobTitle(item)
  if (item.kind === 'environment') return '取消构建'
  if (item.kind === 'upload') return `取消上传 ${title}`
  if (item.kind === 'connector') return `取消添加 ${title}`
  return `停止 ${title}`
}

function timeLabel(value: string | number | undefined): string {
  if (value === undefined) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

/** Fields of the in-panel detail view. Connector and Jupyter jobs add their own sections. */
export function jobDetailFields(item: UnifiedBackgroundJob, nowMs: number): JobDetailField[] {
  if (item.kind === 'history') return item.snapshot.fields
  const status = jobStatus(item).label
  const fields: Array<JobDetailField | undefined> = (() => {
    switch (item.kind) {
      case 'notebook-ai':
        return [
          { label: 'Notebook', value: item.job.notebookPath || item.job.notebookName },
          { label: '项目', value: item.job.projectCwd },
          { label: '模型', value: item.job.model },
          { label: '状态', value: status },
          item.job.cellCount === undefined
            ? undefined
            : { label: '生成单元', value: `${item.job.cellCount} 个单元` },
          { label: '开始时间', value: timeLabel(item.job.startedAt) },
          { label: '耗时', value: elapsed(item.job.startedAt, item.job.completedAt, nowMs) },
          item.job.completedAt
            ? { label: '结束时间', value: timeLabel(item.job.completedAt) }
            : undefined,
          { label: '当前步骤', value: NOTEBOOK_AI_PHASE_LABELS[item.job.phase] },
          { label: '请求', value: item.job.prompt },
          item.job.sourcePreview
            ? { label: '生成内容预览', value: item.job.sourcePreview, mono: true, scroll: true }
            : undefined,
          item.job.error ? { label: '错误', value: item.job.error, mono: true } : undefined
        ]
      case 'agent':
        return [
          { label: '对话', value: item.run.sessionTitle },
          { label: '任务', value: item.run.task },
          { label: '状态', value: status },
          item.run.historyAvailable === false
            ? { label: '说明', value: '旧连接的任务记录；执行历史不可用，未自动重启。' }
            : undefined,
          { label: '开始时间', value: timeLabel(item.run.startedAt) },
          {
            label: '耗时',
            value: elapsed(item.run.startedAt, item.run.completedAt, nowMs)
          },
          item.run.lastStep ? { label: '最近一步', value: item.run.lastStep } : undefined,
          item.run.toolCalls ? { label: '工具调用', value: `${item.run.toolCalls} 步` } : undefined
        ]
      case 'shell':
        return [
          { label: '对话', value: item.run.sessionTitle },
          { label: '命令', value: item.run.command, mono: true },
          { label: '状态', value: status },
          { label: '开始时间', value: timeLabel(item.run.startedAt) },
          {
            label: '耗时',
            value: elapsed(item.run.startedAt, item.run.completedAt, nowMs)
          },
          { label: '输出', value: item.run.output || '没有输出', mono: true, scroll: true }
        ]
      case 'wrapper':
        return [
          { label: 'Wrapper', value: item.run.wrapper.canonicalId },
          { label: '运行 ID', value: item.run.runId, mono: true },
          { label: '状态', value: status },
          runProgressLabel(item.run)
            ? { label: '进度', value: runProgressLabel(item.run) ?? '' }
            : undefined,
          { label: '开始时间', value: timeLabel(item.run.startedAt ?? item.run.createdAt) },
          {
            label: '耗时',
            value: elapsed(item.run.startedAt ?? item.run.createdAt, item.run.completedAt, nowMs)
          },
          { label: '输出目录', value: item.run.outDir },
          item.run.environmentError
            ? { label: '环境错误', value: item.run.environmentError, mono: true }
            : undefined,
          item.run.inputErrors?.length
            ? { label: '输入错误', value: item.run.inputErrors.join('\n'), mono: true }
            : undefined,
          item.run.launchDiagnostic
            ? { label: '启动诊断', value: item.run.launchDiagnostic, mono: true }
            : undefined
        ]
      case 'environment':
        return [
          { label: '环境', value: item.build.ref },
          { label: '环境 ID', value: item.build.envId, mono: true },
          { label: '状态', value: status },
          { label: '进度', value: environmentBuildDetail(item.build) },
          { label: '开始时间', value: timeLabel(item.build.startedAt) },
          {
            label: '耗时',
            value: elapsed(item.build.startedAt, item.build.finishedAt, nowMs)
          },
          item.build.message ? { label: '说明', value: item.build.message } : undefined,
          item.build.error ? { label: '错误', value: item.build.error, mono: true } : undefined
        ]
      case 'upload':
        return [
          { label: '文件', value: item.upload.files.map((file) => file.name).join('\n') },
          { label: '目标目录', value: item.upload.destinationDirectory || '项目根目录' },
          { label: '状态', value: status },
          { label: '进度', value: uploadDetail(item.upload) },
          { label: '开始时间', value: timeLabel(item.upload.createdAt) },
          item.upload.error ? { label: '错误', value: item.upload.error, mono: true } : undefined
        ]
      case 'jupyter':
        return [
          { label: '项目', value: item.job.projectName },
          { label: '服务器', value: item.job.serverLabel },
          { label: '状态', value: status },
          { label: '当前步骤', value: item.job.phase },
          { label: '开始时间', value: timeLabel(item.job.startedAt) },
          {
            label: '耗时',
            value: elapsed(item.job.startedAt, item.job.finishedAt, nowMs)
          },
          item.job.error ? { label: '错误', value: item.job.error, mono: true } : undefined
        ]
      case 'connector':
        return []
    }
  })()
  return fields.filter(
    (field): field is JobDetailField => field !== undefined && field.value !== ''
  )
}
