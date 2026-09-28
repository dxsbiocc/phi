import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { BackgroundAgentJob } from '../../../../shared/backgroundJobTypes'
import type { WrapperRun } from '../../../../shared/wrapperTypes'
import { PhiIcons } from '../../icons'
import { formatAgentDuration } from '../../lib/agentRunsOverview'
import { runProgressLabel, runStateLabel } from '../wrapper/lib/wrapperView'
import {
  canStopUnifiedWrapperRun,
  selectBackgroundJobs,
  type UnifiedBackgroundJob
} from './lib/backgroundJobs'

const StopIcon = PhiIcons.action.stop
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

function jobTitle(item: UnifiedBackgroundJob): string {
  return item.kind === 'agent'
    ? item.run.agentName
    : item.run.runName || item.run.wrapper.shortId || item.run.wrapper.canonicalId
}

function jobDetail(item: UnifiedBackgroundJob, nowMs: number): string {
  if (item.kind === 'wrapper') {
    return [runStateLabel(item.run.state), runProgressLabel(item.run)].filter(Boolean).join(' · ')
  }
  const startedAtMs = Date.parse(item.run.startedAt)
  const elapsed = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0
  return [
    agentStateLabel(item.run.state),
    item.active ? formatAgentDuration(elapsed) : undefined,
    item.run.lastStep,
    item.run.toolCalls ? `${item.run.toolCalls} 步` : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}

export function BackgroundJobsPanel({
  onOpenSession,
  onOpenWrapper
}: {
  onOpenSession: (path: string) => void
  onOpenWrapper: (canonicalId: string) => void
}): React.JSX.Element {
  const [agentJobs, setAgentJobs] = useState<BackgroundAgentJob[]>([])
  const [wrapperRuns, setWrapperRuns] = useState<WrapperRun[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [stoppingKey, setStoppingKey] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const refreshingRef = useRef(false)
  const jobs = selectBackgroundJobs(agentJobs, wrapperRuns)

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    try {
      if (typeof window.api.listAgentJobs !== 'function') {
        setError('请重启 Phi 以查看后台任务。')
        setLoaded(true)
        return
      }
      const [agents, wrappers] = await Promise.allSettled([
        window.api.listAgentJobs(),
        window.api.listWrapperRuns()
      ])
      if (agents.status === 'fulfilled') setAgentJobs(agents.value)
      if (wrappers.status === 'fulfilled') setWrapperRuns(wrappers.value)
      setError(
        agents.status === 'rejected' || wrappers.status === 'rejected'
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

  const openJob = (item: UnifiedBackgroundJob): void => {
    if (item.kind === 'agent') onOpenSession(item.run.sessionPath)
    else onOpenWrapper(item.run.wrapper.canonicalId)
  }

  const stopJob = async (item: UnifiedBackgroundJob): Promise<void> => {
    setStoppingKey(item.key)
    setError('')
    try {
      if (item.kind === 'agent') {
        await window.api.stopAgentRun(item.run.agentSessionId, item.run.agentRunId)
      } else {
        await window.api.cancelWrapperRun(item.run.runId)
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '停止任务失败')
    } finally {
      setStoppingKey(null)
    }
  }

  const renderRow = (item: UnifiedBackgroundJob): React.JSX.Element => {
    const canStop = item.kind === 'agent' ? item.active : canStopUnifiedWrapperRun(item.run)
    const source = item.kind === 'agent' ? item.run.sessionTitle : 'Wrapper'
    const subtitle = item.kind === 'agent' ? item.run.task : item.run.runId
    return (
      <Box
        key={item.key}
        sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1, mb: 1 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 700 }} title={jobTitle(item)}>
            {jobTitle(item)}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            component="div"
            title={subtitle}
          >
            {source} · {subtitle}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            component="div"
            title={jobDetail(item, nowMs)}
          >
            {jobDetail(item, nowMs)}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ mt: 0.5, justifyContent: 'flex-end' }}>
          <Button size="small" onClick={() => openJob(item)} aria-label={`查看 ${jobTitle(item)}`}>
            查看
          </Button>
          {canStop && (
            <Tooltip title={item.kind === 'agent' ? '停止这个 Agent' : '取消这个 Wrapper 运行'}>
              <span>
                <IconButton
                  size="small"
                  aria-label={`停止 ${jobTitle(item)}`}
                  disabled={stoppingKey === item.key}
                  onClick={() => void stopJob(item)}
                >
                  <StopIcon size={15} />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>
      </Box>
    )
  }

  return (
    <Box
      role="region"
      aria-label="后台任务"
      data-phi-background-jobs-panel="true"
      sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
        <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 700 }}>
          后台任务 · {jobs.active.length} 个进行中
        </Typography>
        <Button size="small" onClick={() => void refresh()}>
          刷新
        </Button>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
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
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mt: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}
            >
              最近结束
            </Typography>
            {jobs.recent.map(renderRow)}
          </>
        )}
      </Box>
    </Box>
  )
}
