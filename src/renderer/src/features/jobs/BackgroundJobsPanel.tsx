import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import { useEffect, useState } from 'react'

import { PhiIcons } from '../../icons'
import { workspacePanelText } from '../../layout'
import { BackgroundJobDetail } from './components/BackgroundJobDetail'
import { BackgroundJobGroup } from './components/BackgroundJobGroup'
import { BackgroundJobRow } from './components/BackgroundJobRow'
import { useBackgroundJobsData } from './hooks/useBackgroundJobsData'
import type { UnifiedBackgroundJob } from './lib/backgroundJobs'
import {
  resolveRequestedBackgroundJobKey,
  resolveSelectedBackgroundJob
} from './lib/requestedBackgroundJob'

const ClearIcon = PhiIcons.action.delete

export { LATEST_JUPYTER_JOB_KEY } from './lib/requestedBackgroundJob'

function canRetry(item: UnifiedBackgroundJob): boolean {
  return (
    (item.kind === 'connector' && item.setup.phase === 'failed') ||
    (item.kind === 'upload' && item.upload.status === 'failed')
  )
}

export function BackgroundJobsPanel({
  onOpenSession,
  onOpenWrapper,
  requestedConnectorJobId,
  onRequestedConnectorJobHandled,
  requestedJobKey,
  onRequestedJobHandled,
  onOpenSetupAgent,
  onOpenSetupTerminal
}: {
  onOpenSession: (path: string) => void
  onOpenWrapper?: (canonicalId: string) => void
  requestedConnectorJobId?: string | null
  onRequestedConnectorJobHandled?: (id: string) => void
  /** A job key, `LATEST_JUPYTER_JOB_KEY`, or a key from `notebookAiJobRequestKey`. */
  requestedJobKey?: string | null
  onRequestedJobHandled?: (key: string) => void
  onOpenSetupAgent?: (prompt: string) => void
  onOpenSetupTerminal?: (command: string) => void
}): React.JSX.Element {
  const { data, jobs, loaded, error, nowMs, refresh, setError, clearCompleted } =
    useBackgroundJobsData()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [runningExpanded, setRunningExpanded] = useState(true)
  const [finishedExpanded, setFinishedExpanded] = useState(false)
  const all = [...jobs.active, ...jobs.recent]
  const selected = resolveSelectedBackgroundJob(selectedKey, all, data.notebookAiJobs)

  useEffect(() => {
    if (!requestedConnectorJobId || !loaded) return
    const exists = [...jobs.active, ...jobs.recent].some(
      (item) => item.key === `connector:${requestedConnectorJobId}`
    )
    const timer = window.setTimeout(() => {
      if (exists) setSelectedKey(`connector:${requestedConnectorJobId}`)
      onRequestedConnectorJobHandled?.(requestedConnectorJobId)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [jobs.active, jobs.recent, loaded, onRequestedConnectorJobHandled, requestedConnectorJobId])

  useEffect(() => {
    if (!requestedJobKey || !loaded) return
    const key = resolveRequestedBackgroundJobKey(requestedJobKey, data, jobs.recent)
    if (!key) return
    const timer = window.setTimeout(() => {
      if (key) setSelectedKey(key)
      onRequestedJobHandled?.(requestedJobKey)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [data, jobs.recent, loaded, onRequestedJobHandled, requestedJobKey])

  const run = async (
    item: UnifiedBackgroundJob,
    action: () => Promise<unknown>,
    failure: string
  ): Promise<void> => {
    setBusyKey(item.key)
    setError('')
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure)
    } finally {
      setBusyKey(null)
    }
  }

  const stopJob = (item: UnifiedBackgroundJob): void => {
    const api = window.api
    const action = (): Promise<unknown> => {
      switch (item.kind) {
        case 'agent':
          return api.stopAgentRun(item.run.agentSessionId, item.run.agentRunId)
        case 'shell':
          return api.stopShellJob(item.run.agentSessionId, item.run.jobId)
        case 'wrapper':
          return api.cancelWrapperRun(item.run.runId)
        case 'upload':
          return api.cancelRemoteProjectUpload(item.upload.id)
        case 'environment':
          return api.cancelEnvironmentBuild(item.build.envId)
        case 'connector':
          return api.cancelLocalConnectorAdd(item.setup.id)
        case 'jupyter':
        case 'notebook-ai':
        case 'history':
          return Promise.resolve()
      }
    }
    void run(item, action, '停止任务失败')
  }

  const retryJob = (item: UnifiedBackgroundJob): void => {
    if (item.kind === 'connector') {
      void run(item, () => window.api.retryLocalConnectorAdd(item.setup.id), '重试失败')
    } else if (item.kind === 'upload') {
      void run(item, () => window.api.retryRemoteProjectUpload(item.upload.id), '重试上传失败')
    }
  }

  const renderRow = (item: UnifiedBackgroundJob): React.JSX.Element => (
    <BackgroundJobRow
      key={item.key}
      item={item}
      nowMs={nowMs}
      busy={busyKey === item.key}
      onOpen={(job) => setSelectedKey(job.key)}
      onStop={stopJob}
      {...(canRetry(item) ? { onRetry: retryJob } : {})}
    />
  )

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
      {error && (
        <Typography
          variant="caption"
          color="error.main"
          sx={{ ...workspacePanelText.body, px: 1.5, mb: 0.5 }}
        >
          {error}
        </Typography>
      )}
      {selected ? (
        <BackgroundJobDetail
          item={selected}
          nowMs={nowMs}
          busy={busyKey === selected.key}
          onBack={() => setSelectedKey(null)}
          onStop={stopJob}
          {...(canRetry(selected) ? { onRetry: retryJob } : {})}
          onOpenSession={onOpenSession}
          {...(onOpenWrapper ? { onOpenWrapper } : {})}
          {...(onOpenSetupAgent ? { onOpenSetupAgent } : {})}
          {...(onOpenSetupTerminal ? { onOpenSetupTerminal } : {})}
        />
      ) : (
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowX: 'hidden',
            overflowY: 'auto',
            scrollbarGutter: 'stable both-edges'
          }}
        >
          {!loaded && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ ...workspacePanelText.body, py: 1 }}
            >
              正在读取任务…
            </Typography>
          )}
          {loaded && all.length === 0 && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ ...workspacePanelText.body, py: 1 }}
            >
              暂无任务
            </Typography>
          )}
          {loaded && all.length > 0 && (
            <>
              <BackgroundJobGroup
                id="running"
                title="运行中"
                count={jobs.active.length}
                expanded={runningExpanded}
                onToggle={() => setRunningExpanded((value) => !value)}
              >
                {jobs.active.length === 0 ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ...workspacePanelText.body, px: 0.5 }}
                  >
                    没有运行中的任务
                  </Typography>
                ) : (
                  jobs.active.map(renderRow)
                )}
              </BackgroundJobGroup>
              <BackgroundJobGroup
                id="finished"
                title="已完成"
                count={jobs.recent.length}
                expanded={finishedExpanded}
                onToggle={() => setFinishedExpanded((value) => !value)}
                action={
                  jobs.recent.length > 0 ? (
                    <Tooltip title="清除已完成记录，运行中的任务不受影响">
                      <IconButton size="small" aria-label="清除已完成" onClick={clearCompleted}>
                        <ClearIcon size={15} />
                      </IconButton>
                    </Tooltip>
                  ) : undefined
                }
              >
                {jobs.recent.length === 0 ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ...workspacePanelText.body, px: 0.5 }}
                  >
                    还没有已结束的任务
                  </Typography>
                ) : (
                  jobs.recent.map(renderRow)
                )}
              </BackgroundJobGroup>
            </>
          )}
        </Box>
      )}
    </Box>
  )
}
