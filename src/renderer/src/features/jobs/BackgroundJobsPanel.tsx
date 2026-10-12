import { Box, Button, IconButton, LinearProgress, Stack, Tooltip, Typography } from '@mui/material'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { BackgroundAgentJob, BackgroundShellJob } from '../../../../shared/backgroundJobTypes'
import type { EnvironmentBuild } from '../../../../shared/environmentBuildTypes'
import type { McpConnectorSetupProgress } from '../../../../shared/mcpConnectorCatalog'
import type { RemoteProjectUploadJob } from '../../../../shared/remoteProjectUploadTypes'
import type { WrapperRun } from '../../../../shared/wrapperTypes'
import { PhiIcons } from '../../icons'
import { formatAgentDuration } from '../../lib/agentRunsOverview'
import { runProgressLabel, runStateLabel } from '../wrapper/lib/wrapperView'
import { ConnectorJobDetailDialog } from './components/ConnectorJobDetailDialog'
import {
  backgroundJobTrayStartedAt,
  canStopUnifiedWrapperRun,
  dismissBackgroundJobs,
  dismissedBackgroundJobKeys,
  environmentBuildDetail,
  environmentBuildPercent,
  environmentBuildTitle,
  connectorJobDetail,
  selectBackgroundJobs,
  type UnifiedBackgroundJob
} from './lib/backgroundJobs'

const StopIcon = PhiIcons.action.stop
const ClearIcon = PhiIcons.action.delete
const REFRESH_MS = 2000

function agentStateLabel(state: BackgroundAgentJob['state']): string {
  const labels = {
    queued: '排队中',
    running: '运行中',
    done: '已完成',
    error: '失败',
    cancelled: '已停止'
  } satisfies Record<BackgroundAgentJob['state'], string>
  return labels[state]
}

function shellStateLabel(state: BackgroundShellJob['state']): string {
  const labels = {
    queued: '排队中',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已停止'
  } satisfies Record<BackgroundShellJob['state'], string>
  return labels[state]
}

const UPLOAD_STATE_LABELS: Record<RemoteProjectUploadJob['status'], string> = {
  queued: '排队',
  uploading: '上传中',
  verifying: '校验',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消'
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

function uploadPercent(upload: RemoteProjectUploadJob): number | undefined {
  if (upload.totalBytes <= 0) return undefined
  return Math.min(100, Math.max(0, (upload.bytesTransferred / upload.totalBytes) * 100))
}

function jobTitle(item: UnifiedBackgroundJob): string {
  if (item.kind === 'connector') return item.setup.title ?? item.setup.id
  if (item.kind === 'environment') return environmentBuildTitle(item.build)
  if (item.kind === 'upload') return uploadTitle(item.upload)
  if (item.kind === 'agent') return item.run.agentName
  if (item.kind === 'shell') return item.run.command
  return item.run.runName || item.run.wrapper.shortId || item.run.wrapper.canonicalId
}

function jobSource(item: UnifiedBackgroundJob): string {
  if (item.kind === 'connector') return '连接器'
  if (item.kind === 'environment') return '环境'
  if (item.kind === 'upload') return '上传'
  if (item.kind === 'wrapper') return 'Wrapper'
  return item.run.sessionTitle
}

function jobSubtitle(item: UnifiedBackgroundJob): string {
  if (item.kind === 'connector') return item.setup.summary ?? item.setup.id
  if (item.kind === 'environment') return item.build.envId
  if (item.kind === 'upload') return item.upload.destinationDirectory || '项目根目录'
  if (item.kind === 'agent') return item.run.task
  if (item.kind === 'shell') return '后台命令'
  return item.run.runId
}

function jobDetail(item: UnifiedBackgroundJob, nowMs: number): string {
  if (item.kind === 'connector') return connectorJobDetail(item.setup, nowMs)
  if (item.kind === 'environment') return environmentBuildDetail(item.build)
  if (item.kind === 'upload') return uploadDetail(item.upload)
  if (item.kind === 'wrapper') {
    return [runStateLabel(item.run.state), runProgressLabel(item.run)].filter(Boolean).join(' · ')
  }
  const startedAtMs = Date.parse(item.run.startedAt)
  const elapsed = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0
  if (item.kind === 'shell') {
    return [
      shellStateLabel(item.run.state),
      item.active ? formatAgentDuration(elapsed) : undefined,
      item.run.output
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return [
    agentStateLabel(item.run.state),
    item.active ? formatAgentDuration(elapsed) : undefined,
    item.run.lastStep,
    item.run.toolCalls ? `${item.run.toolCalls} 步` : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}

function canStopJob(item: UnifiedBackgroundJob): boolean {
  if (item.kind === 'wrapper') return canStopUnifiedWrapperRun(item.run)
  return item.active
}

function stopTooltip(item: UnifiedBackgroundJob): string {
  if (item.kind === 'connector') return '取消添加'
  if (item.kind === 'environment') return '取消构建'
  if (item.kind === 'upload') return '取消上传'
  if (item.kind === 'agent') return '停止这个 Agent'
  if (item.kind === 'shell') return '停止这个后台命令'
  return '取消这个 Wrapper 运行'
}

function upsertEnvironmentBuild(
  current: readonly EnvironmentBuild[],
  build: EnvironmentBuild
): EnvironmentBuild[] {
  const index = current.findIndex((item) => item.envId === build.envId)
  if (index === -1) return [build, ...current]
  const next = current.slice()
  next[index] = build
  return next
}

function upsertConnectorJob(
  current: readonly McpConnectorSetupProgress[],
  setup: McpConnectorSetupProgress
): McpConnectorSetupProgress[] {
  if (setup.kind !== 'local-stdio') return [...current]
  const index = current.findIndex((item) => item.id === setup.id)
  if (index === -1) return [setup, ...current]
  const next = current.slice()
  next[index] = setup
  return next
}

function upsertUploadJob(
  current: readonly RemoteProjectUploadJob[],
  job: RemoteProjectUploadJob
): RemoteProjectUploadJob[] {
  const index = current.findIndex((item) => item.id === job.id)
  if (index === -1) return [job, ...current]
  const next = current.slice()
  next[index] = job
  return next
}

export function BackgroundJobsPanel({
  onOpenSession,
  onOpenWrapper,
  requestedConnectorJobId,
  onRequestedConnectorJobHandled,
  onOpenSetupAgent,
  onOpenSetupTerminal
}: {
  onOpenSession: (path: string) => void
  onOpenWrapper?: (canonicalId: string) => void
  requestedConnectorJobId?: string | null
  onRequestedConnectorJobHandled?: (id: string) => void
  onOpenSetupAgent?: (prompt: string) => void
  onOpenSetupTerminal?: (command: string) => void
}): React.JSX.Element {
  const [agentJobs, setAgentJobs] = useState<BackgroundAgentJob[]>([])
  const [shellJobs, setShellJobs] = useState<BackgroundShellJob[]>([])
  const [wrapperRuns, setWrapperRuns] = useState<WrapperRun[]>([])
  const [environmentBuilds, setEnvironmentBuilds] = useState<EnvironmentBuild[]>([])
  const [connectorJobs, setConnectorJobs] = useState<McpConnectorSetupProgress[]>([])
  const [uploadJobs, setUploadJobs] = useState<RemoteProjectUploadJob[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [stoppingKey, setStoppingKey] = useState<string | null>(null)
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(
    () => new Set(dismissedBackgroundJobKeys())
  )
  const refreshingRef = useRef(false)
  const jobs = selectBackgroundJobs(
    agentJobs,
    wrapperRuns,
    {
      finishedAfter: backgroundJobTrayStartedAt(),
      dismissedKeys
    },
    shellJobs,
    environmentBuilds,
    connectorJobs,
    uploadJobs
  )
  const selectedConnector = connectorJobs.find((setup) => setup.id === selectedConnectorId)

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    try {
      if (typeof window.api.listAgentJobs !== 'function') {
        setError('请重启 Phi 以查看后台任务。')
        setLoaded(true)
        return
      }
      const [agents, shells, wrappers, builds, connectors, uploads] = await Promise.allSettled([
        window.api.listAgentJobs(),
        typeof window.api.listShellJobs === 'function'
          ? window.api.listShellJobs()
          : Promise.resolve<BackgroundShellJob[]>([]),
        window.api.listWrapperRuns(),
        typeof window.api.listEnvironmentBuilds === 'function'
          ? window.api.listEnvironmentBuilds()
          : Promise.resolve<EnvironmentBuild[]>([]),
        typeof window.api.listLocalConnectorJobs === 'function'
          ? window.api.listLocalConnectorJobs()
          : Promise.resolve<McpConnectorSetupProgress[]>([]),
        typeof window.api.listRemoteProjectUploads === 'function'
          ? window.api.listRemoteProjectUploads()
          : Promise.resolve<RemoteProjectUploadJob[]>([])
      ])
      if (agents.status === 'fulfilled') setAgentJobs(agents.value)
      if (shells.status === 'fulfilled') setShellJobs(shells.value)
      if (wrappers.status === 'fulfilled') setWrapperRuns(wrappers.value)
      if (builds.status === 'fulfilled') setEnvironmentBuilds(builds.value)
      if (connectors.status === 'fulfilled') setConnectorJobs(connectors.value)
      if (uploads.status === 'fulfilled') setUploadJobs(uploads.value)
      setError(
        agents.status === 'rejected' ||
          shells.status === 'rejected' ||
          wrappers.status === 'rejected' ||
          builds.status === 'rejected' ||
          connectors.status === 'rejected' ||
          uploads.status === 'rejected'
          ? '部分任务状态暂时无法读取，稍后会自动重试。'
          : ''
      )
      setLoaded(true)
      setNowMs(Date.now())
    } finally {
      refreshingRef.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (typeof window.api.onEnvironmentBuildsChanged !== 'function') return undefined
    return window.api.onEnvironmentBuildsChanged((build) => {
      setEnvironmentBuilds((current) => upsertEnvironmentBuild(current, build))
    })
  }, [])

  useEffect(() => {
    if (typeof window.api.onMcpConnectorSetupChanged !== 'function') return undefined
    return window.api.onMcpConnectorSetupChanged((setup) => {
      if (setup.kind === 'local-stdio') {
        setConnectorJobs((current) => upsertConnectorJob(current, setup))
      }
    })
  }, [])

  useEffect(() => {
    if (!requestedConnectorJobId) return
    if (!connectorJobs.some((setup) => setup.id === requestedConnectorJobId)) return
    const timer = window.setTimeout(() => {
      setSelectedConnectorId(requestedConnectorJobId)
      onRequestedConnectorJobHandled?.(requestedConnectorJobId)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [connectorJobs, onRequestedConnectorJobHandled, requestedConnectorJobId])

  useEffect(() => {
    if (typeof window.api.onRemoteProjectUploadsChanged !== 'function') return undefined
    return window.api.onRemoteProjectUploadsChanged((job) => {
      setUploadJobs((current) => upsertUploadJob(current, job))
    })
  }, [])

  const clearRecent = (): void => {
    dismissBackgroundJobs(jobs.recent.map((item) => item.key))
    setDismissedKeys(new Set(dismissedBackgroundJobKeys()))
  }

  const openJob = (item: UnifiedBackgroundJob): void => {
    if (item.kind === 'connector') {
      setSelectedConnectorId(item.setup.id)
    } else if (item.kind === 'agent' || item.kind === 'shell') {
      onOpenSession(item.run.sessionPath)
    } else if (item.kind === 'wrapper') {
      onOpenWrapper?.(item.run.wrapper.canonicalId)
    }
  }

  const stopJob = async (item: UnifiedBackgroundJob): Promise<void> => {
    setStoppingKey(item.key)
    setError('')
    try {
      if (item.kind === 'agent') {
        await window.api.stopAgentRun(item.run.agentSessionId, item.run.agentRunId)
      } else if (item.kind === 'shell') {
        await window.api.stopShellJob(item.run.agentSessionId, item.run.jobId)
      } else if (item.kind === 'wrapper') {
        await window.api.cancelWrapperRun(item.run.runId)
      } else if (item.kind === 'upload') {
        await window.api.cancelRemoteProjectUpload(item.upload.id)
      } else if (item.kind === 'environment') {
        await window.api.cancelEnvironmentBuild(item.build.envId)
      } else {
        await window.api.cancelLocalConnectorAdd(item.setup.id)
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '停止任务失败')
    } finally {
      setStoppingKey(null)
    }
  }

  const retryJob = async (item: UnifiedBackgroundJob): Promise<void> => {
    if (item.kind !== 'connector') return
    setStoppingKey(item.key)
    setError('')
    try {
      await window.api.retryLocalConnectorAdd(item.setup.id)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试失败')
    } finally {
      setStoppingKey(null)
    }
  }

  const retryUpload = async (
    item: Extract<UnifiedBackgroundJob, { kind: 'upload' }>
  ): Promise<void> => {
    setStoppingKey(item.key)
    setError('')
    try {
      await window.api.retryRemoteProjectUpload(item.upload.id)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试上传失败')
    } finally {
      setStoppingKey(null)
    }
  }

  const renderRow = (item: UnifiedBackgroundJob): React.JSX.Element => {
    const canStop = canStopJob(item)
    const canOpen =
      item.kind === 'agent' || item.kind === 'shell' || (item.kind === 'wrapper' && onOpenWrapper)
    const canRetry = item.kind === 'connector' && item.setup.phase === 'failed'
    const canRetryUpload = item.kind === 'upload' && item.upload.status === 'failed'
    const title = jobTitle(item)
    const subtitle = jobSubtitle(item)
    const detail = jobDetail(item, nowMs)
    const percent =
      item.kind === 'environment'
        ? environmentBuildPercent(item.build)
        : item.kind === 'upload'
          ? uploadPercent(item.upload)
          : undefined
    return (
      <Box
        key={item.key}
        role={item.kind === 'connector' ? 'button' : undefined}
        tabIndex={item.kind === 'connector' ? 0 : undefined}
        aria-label={item.kind === 'connector' ? `查看 ${title} 详情` : undefined}
        onClick={item.kind === 'connector' ? () => openJob(item) : undefined}
        onKeyDown={
          item.kind === 'connector'
            ? (event) => {
                if (event.currentTarget !== event.target) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  openJob(item)
                }
              }
            : undefined
        }
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: 1.5,
          p: 1,
          mb: 1,
          minWidth: 0,
          ...(item.kind === 'connector'
            ? {
                cursor: 'pointer',
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 1
                }
              }
            : {})
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 700 }} title={title}>
            {title}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap={item.kind !== 'connector'}
            component="div"
            title={`${jobSource(item)} · ${subtitle}`}
            sx={
              item.kind === 'connector'
                ? {
                    minWidth: 0,
                    overflow: 'hidden',
                    overflowWrap: 'anywhere',
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 2
                  }
                : undefined
            }
          >
            {jobSource(item)} · {subtitle}
          </Typography>
          <Typography
            variant="caption"
            color={
              item.kind === 'connector' && item.setup.failureKind === 'needs-setup'
                ? 'warning.main'
                : 'text.secondary'
            }
            noWrap={item.kind !== 'connector'}
            component="div"
            title={detail}
            sx={
              item.kind === 'connector'
                ? {
                    minWidth: 0,
                    overflow: 'hidden',
                    overflowWrap: 'anywhere',
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 2
                  }
                : undefined
            }
          >
            {detail}
          </Typography>
          {(item.kind === 'environment' || item.kind === 'upload') && item.active && (
            <LinearProgress
              variant={percent === undefined ? 'indeterminate' : 'determinate'}
              value={percent ?? 0}
              aria-label={item.kind === 'upload' ? '文件上传进度' : '环境构建进度'}
              sx={{ mt: 0.75, height: 2, borderRadius: 1 }}
            />
          )}
        </Box>
        {(canOpen || canStop || canRetry || canRetryUpload) && (
          <Stack direction="row" spacing={1} sx={{ mt: 0.5, justifyContent: 'flex-end' }}>
            {canOpen && (
              <Button
                size="small"
                onClick={() => openJob(item)}
                aria-label={
                  item.kind === 'agent' || item.kind === 'shell'
                    ? `打开对话 ${title}`
                    : `查看 ${title}`
                }
              >
                {item.kind === 'agent' || item.kind === 'shell' ? '打开对话' : '查看'}
              </Button>
            )}
            {canStop && (
              <Tooltip title={stopTooltip(item)}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={
                      item.kind === 'environment'
                        ? '取消构建'
                        : item.kind === 'upload'
                          ? `取消上传 ${title}`
                          : item.kind === 'connector'
                            ? `取消添加 ${title}`
                            : `停止 ${title}`
                    }
                    disabled={stoppingKey === item.key}
                    onClick={(event) => {
                      event.stopPropagation()
                      void stopJob(item)
                    }}
                  >
                    <StopIcon size={15} />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            {canRetryUpload && item.kind === 'upload' && (
              <Button
                size="small"
                disabled={stoppingKey === item.key}
                onClick={() => void retryUpload(item)}
              >
                重试
              </Button>
            )}
            {canRetry && (
              <Button
                size="small"
                disabled={stoppingKey === item.key}
                onClick={(event) => {
                  event.stopPropagation()
                  void retryJob(item)
                }}
              >
                重试
              </Button>
            )}
          </Stack>
        )}
      </Box>
    )
  }

  return (
    <Box
      role="region"
      aria-label="后台任务"
      data-phi-background-jobs-panel="true"
      sx={{
        flex: 1,
        width: '100%',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper'
      }}
    >
      <Stack direction="row" spacing={1} sx={{ mb: 1, minWidth: 0, alignItems: 'center' }}>
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
          后台任务 · {jobs.active.length} 个进行中
        </Typography>
        <Button size="small" onClick={() => void refresh()} sx={{ flexShrink: 0 }}>
          刷新
        </Button>
      </Stack>
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowX: 'hidden', overflowY: 'auto' }}>
        {error && (
          <Typography variant="caption" color="error.main">
            {error}
          </Typography>
        )}
        {!loaded && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
            正在读取任务…
          </Typography>
        )}
        {loaded && jobs.active.length === 0 && jobs.recent.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
            暂无任务
          </Typography>
        )}
        {loaded && jobs.active.map(renderRow)}
        {loaded && jobs.recent.length > 0 && (
          <>
            <Stack
              direction="row"
              spacing={1}
              sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider', alignItems: 'center' }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                最近结束
              </Typography>
              <Tooltip title="从这里清掉，运行记录仍留在工具页">
                <IconButton
                  size="small"
                  aria-label="清除最近结束"
                  onClick={(event) => {
                    event.stopPropagation()
                    clearRecent()
                  }}
                >
                  <ClearIcon size={15} />
                </IconButton>
              </Tooltip>
            </Stack>
            {jobs.recent.map(renderRow)}
          </>
        )}
      </Box>
      {selectedConnector ? (
        <ConnectorJobDetailDialog
          open
          setup={selectedConnector}
          retrying={stoppingKey === `connector:${selectedConnector.id}`}
          onRetry={() =>
            void retryJob({
              kind: 'connector',
              key: `connector:${selectedConnector.id}`,
              active: false,
              timestamp: selectedConnector.updatedAt,
              setup: selectedConnector
            })
          }
          onOpenSetupAgent={(prompt) => {
            setSelectedConnectorId(null)
            onOpenSetupAgent?.(prompt)
          }}
          onOpenSetupTerminal={(command) => {
            setSelectedConnectorId(null)
            onOpenSetupTerminal?.(command)
          }}
          onClose={() => setSelectedConnectorId(null)}
        />
      ) : null}
    </Box>
  )
}
