import { jobsCopy } from './lib/jobsCopy'
import { OverlayScroll } from '../../components/OverlayScroll'
import { useUiLanguage } from '../../lib/i18n'
import { AnimatedList, AnimatedListItem } from './components/AnimatedList'
import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import { useEffect, useMemo, useState } from 'react'

import { PhiIcons } from '../../icons'
import { workspacePanelText } from '../../layout'
import { BackgroundJobGroup } from '../../components/BackgroundJobGroup'
import { BackgroundJobDetail } from './components/BackgroundJobDetail'
import { BackgroundJobRow } from './components/BackgroundJobRow'
import { BackgroundWorkflowRow } from './components/BackgroundWorkflowRow'
import { useBackgroundJobsData } from './hooks/useBackgroundJobsData'
import type { UnifiedBackgroundJob } from './lib/backgroundJobs'
import { groupBackgroundJobs, type BackgroundJobDisplayItem } from './lib/backgroundJobGroups'
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
  useUiLanguage()
  const { data, jobs, loaded, error, nowMs, refresh, setError, clearCompleted } =
    useBackgroundJobsData()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [runningExpanded, setRunningExpanded] = useState(true)
  const [finishedExpanded, setFinishedExpanded] = useState(false)
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(() => new Set())
  const all = [...jobs.active, ...jobs.recent]
  const display = useMemo(
    () => groupBackgroundJobs([...jobs.active, ...jobs.recent]),
    [jobs.active, jobs.recent]
  )
  const activeDisplay = display.filter((item) => item.active)
  const recentDisplay = display.filter((item) => !item.active)
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
    if (requestedJobKey.startsWith('workflow:')) {
      const workflow = display.find((item) => item.key === requestedJobKey)
      if (!workflow) return
      const timer = window.setTimeout(() => {
        setSelectedKey(null)
        setExpandedWorkflows((current) => new Set(current).add(requestedJobKey))
        if (workflow.active) setRunningExpanded(true)
        else setFinishedExpanded(true)
        onRequestedJobHandled?.(requestedJobKey)
      }, 0)
      return () => window.clearTimeout(timer)
    }
    const key = resolveRequestedBackgroundJobKey(requestedJobKey, data, jobs.recent)
    if (!key) return
    const timer = window.setTimeout(() => {
      if (key) setSelectedKey(key)
      onRequestedJobHandled?.(requestedJobKey)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [data, display, jobs.recent, loaded, onRequestedJobHandled, requestedJobKey])

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
        case 'plugin':
        case 'history':
          return Promise.resolve()
      }
    }
    void run(item, action, jobsCopy.unableToStopTask)
  }

  const retryJob = (item: UnifiedBackgroundJob): void => {
    if (item.kind === 'connector') {
      void run(item, () => window.api.retryLocalConnectorAdd(item.setup.id), jobsCopy.retryFailed)
    } else if (item.kind === 'upload') {
      void run(
        item,
        () => window.api.retryRemoteProjectUpload(item.upload.id),
        jobsCopy.unableToRetryUpload
      )
    }
  }

  const renderRow = (item: UnifiedBackgroundJob, index: number): React.JSX.Element => (
    <AnimatedListItem key={item.key} enterDelayMs={Math.min(index, 4) * 65}>
      <BackgroundJobRow
        item={item}
        nowMs={nowMs}
        busy={busyKey === item.key}
        onOpen={(job) => setSelectedKey(job.key)}
        onStop={stopJob}
        {...(canRetry(item) ? { onRetry: retryJob } : {})}
      />
    </AnimatedListItem>
  )

  const renderDisplayRow = (entry: BackgroundJobDisplayItem, index: number): React.JSX.Element =>
    entry.kind === 'job' ? (
      renderRow(entry.job, index)
    ) : (
      <AnimatedListItem key={entry.key} enterDelayMs={Math.min(index, 4) * 65}>
        <BackgroundWorkflowRow
          workflow={entry}
          expanded={expandedWorkflows.has(entry.key)}
          onToggle={() =>
            setExpandedWorkflows((current) => {
              const next = new Set(current)
              if (next.has(entry.key)) next.delete(entry.key)
              else next.add(entry.key)
              return next
            })
          }
          renderChild={(job) => (
            <BackgroundJobRow
              compact
              item={job}
              nowMs={nowMs}
              busy={busyKey === job.key}
              onOpen={(selectedJob) => setSelectedKey(selectedJob.key)}
              onStop={stopJob}
            />
          )}
        />
      </AnimatedListItem>
    )

  return (
    <Box
      role="region"
      aria-label={jobsCopy.backgroundJobs}
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
        <OverlayScroll sx={{ flex: 1 }}>
          {!loaded && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ ...workspacePanelText.body, py: 1 }}
            >
              {jobsCopy.loadingJobs}
            </Typography>
          )}
          {/* Both groups stay visible when empty, e.g. right after clearing finished jobs. */}
          {loaded && (
            <>
              <BackgroundJobGroup
                id="running"
                title={jobsCopy.running}
                count={activeDisplay.length}
                expanded={runningExpanded}
                onToggle={() => setRunningExpanded((value) => !value)}
              >
                {activeDisplay.length === 0 ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ...workspacePanelText.body, px: 0.5 }}
                  >
                    {jobsCopy.noRunningJobs}
                  </Typography>
                ) : (
                  <AnimatedList animateInitial>{activeDisplay.map(renderDisplayRow)}</AnimatedList>
                )}
              </BackgroundJobGroup>
              <BackgroundJobGroup
                id="finished"
                title={jobsCopy.completed}
                count={recentDisplay.length}
                expanded={finishedExpanded}
                onToggle={() => setFinishedExpanded((value) => !value)}
                action={
                  recentDisplay.length > 0 ? (
                    <Tooltip title={jobsCopy.clearCompletedHistoryRunningJobsAreUnaffected}>
                      <IconButton
                        size="small"
                        aria-label={jobsCopy.clearCompleted}
                        onClick={clearCompleted}
                      >
                        <ClearIcon size={15} />
                      </IconButton>
                    </Tooltip>
                  ) : undefined
                }
              >
                {recentDisplay.length === 0 ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ...workspacePanelText.body, px: 0.5 }}
                  >
                    {jobsCopy.noFinishedJobsYet}
                  </Typography>
                ) : (
                  <AnimatedList animateInitial>{recentDisplay.map(renderDisplayRow)}</AnimatedList>
                )}
              </BackgroundJobGroup>
            </>
          )}
        </OverlayScroll>
      )}
    </Box>
  )
}
