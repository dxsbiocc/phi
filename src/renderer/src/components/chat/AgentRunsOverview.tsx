import {
  Box,
  ButtonBase,
  Chip,
  CircularProgress,
  ClickAwayListener,
  IconButton,
  Paper,
  Popper,
  Tooltip,
  Typography
} from '@mui/material'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { WrapperRun } from '../../../../shared/wrapperTypes'
import { PhiIcons } from '../../icons'
import { isAgentRunGoneError } from '../../lib/agentExecutionControl'
import {
  agentRunLostKey,
  agentRunOverviewLabel,
  formatAgentDuration,
  type AgentRunOverviewEntry
} from '../../lib/agentRunsOverview'
import { runProgressLabel, runStateLabel } from '../../features/wrapper/lib/wrapperView'
import { useLostAgentRunsStore } from '../../stores/lostAgentRunsStore'
import { useHoverIntent } from './useHoverIntent'

const AgentIcon = PhiIcons.entity.agent
const StopIcon = PhiIcons.action.stop

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function elapsedMs(startedAt: string | undefined, nowMs: number): number {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN
  return Number.isFinite(started) ? Math.max(0, nowMs - started) : 0
}

type AgentRunRowProps = {
  run: AgentRunOverviewEntry
  wrapperRun?: WrapperRun
  nowMs: number
  onLocate: (id: string) => void
}

function AgentRunRow({ run, wrapperRun, nowMs, onLocate }: AgentRunRowProps): ReactNode {
  const markLost = useLostAgentRunsStore((state) => state.markLost)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')

  const stop = (): void => {
    const { control } = run
    if (!control) return
    setStopping(true)
    setError('')
    window.api
      .stopAgentRun(control.agentSessionId, control.agentRunId)
      .catch((stopError: unknown) => {
        if (isAgentRunGoneError(stopError)) markLost(agentRunLostKey(control))
        else setError(errorText(stopError))
      })
      .finally(() => setStopping(false))
  }

  const detail = [
    formatAgentDuration(elapsedMs(run.startedAt, nowMs)),
    `步骤 ${run.stepCount}`,
    ...(run.currentStep ? [`当前：${run.currentStep}`] : [])
  ].join(' · ')
  const wrapperDetail = run.wrapperRunId
    ? [
        `Nextflow：${run.wrapperRunId}`,
        ...(wrapperRun ? [runStateLabel(wrapperRun.state)] : ['查询中']),
        ...(wrapperRun ? [runProgressLabel(wrapperRun)].filter(Boolean) : [])
      ].join(' · ')
    : ''

  return (
    <Box component="li" sx={{ listStyle: 'none', minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        <ButtonBase
          onClick={() => onLocate(run.id)}
          aria-label={`在对话中查看 ${run.agentName}`}
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 1,
            px: 1,
            py: 0.75,
            borderRadius: 1,
            textAlign: 'left',
            '&:hover': { bgcolor: 'action.hover' },
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
          }}
        >
          <AgentIcon sx={{ fontSize: 16, mt: '3px', flexShrink: 0, color: 'primary.main' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
              <Typography variant="body2" noWrap sx={{ fontWeight: 600, color: 'text.primary' }}>
                {run.agentName}
              </Typography>
              {run.background ? (
                <Chip
                  label="后台"
                  size="small"
                  variant="outlined"
                  sx={{ height: 18, fontSize: 11 }}
                />
              ) : null}
            </Box>
            <Typography
              variant="caption"
              component="div"
              noWrap
              sx={{ color: 'text.secondary' }}
              title={run.task}
            >
              {run.task || '（没有任务描述）'}
            </Typography>
            <Typography
              variant="caption"
              component="div"
              noWrap
              sx={{ color: 'text.secondary', fontFamily: 'var(--font-mono)' }}
            >
              {detail}
            </Typography>
            {wrapperDetail ? (
              <Typography
                variant="caption"
                component="div"
                noWrap
                sx={{ color: 'text.secondary', fontFamily: 'var(--font-mono)' }}
                title={wrapperDetail}
              >
                {wrapperDetail}
              </Typography>
            ) : null}
          </Box>
        </ButtonBase>
        {run.control ? (
          <Tooltip title="停止这个 Agent" enterDelay={400}>
            <span>
              <IconButton
                size="small"
                aria-label={`停止 ${run.agentName}`}
                disabled={stopping}
                onClick={stop}
                sx={{ width: 28, height: 28, color: 'error.main' }}
              >
                <StopIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
      </Box>
      {error ? (
        <Typography variant="caption" component="div" sx={{ px: 1, color: 'error.main' }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  )
}

type AgentRunsOverviewProps = {
  runs: AgentRunOverviewEntry[]
  /** Scroll the conversation to this run's card. */
  onLocate: (id: string) => void
}

// Long enough that sweeping the pointer across the corner does not flash the list open, short
// enough to feel immediate. The close delay lets the pointer cross the gap to the list.
const HOVER_OPEN_DELAY_MS = 120
const HOVER_CLOSE_DELAY_MS = 220
const WRAPPER_RUN_POLL_INTERVAL_MS = 2000

/**
 * A small button over the chat's top-right corner that says how many agents are running. Resting
 * the pointer on it (or clicking it, which keeps it open) shows a list of them with what each is
 * doing, a way to stop it, and a way to jump to its card in the conversation. Renders nothing
 * while no agent is running.
 */
function AgentRunsOverview({ runs, onLocate }: AgentRunsOverviewProps): ReactNode {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [pinned, setPinned] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [wrapperRuns, setWrapperRuns] = useState<ReadonlyMap<string, WrapperRun>>(() => new Map())
  const hover = useHoverIntent({
    openDelayMs: HOVER_OPEN_DELAY_MS,
    closeDelayMs: HOVER_CLOSE_DELAY_MS
  })
  const open = (hover.hovering || pinned) && runs.length > 0
  const { reset: resetHover } = hover
  const wrapperRunIds = useMemo(
    () => [...new Set(runs.map((run) => run.wrapperRunId).filter((id): id is string => !!id))],
    [runs]
  )

  useEffect(() => {
    if (!open) return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setPinned(false)
      resetHover()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, resetHover])

  useEffect(() => {
    if (wrapperRunIds.length === 0) {
      return undefined
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = (): void => {
      Promise.all(
        wrapperRunIds.map(async (runId) => {
          try {
            return [runId, await window.api.getWrapperRun(runId)] as const
          } catch {
            return [runId, undefined] as const
          }
        })
      )
        .then((results) => {
          if (cancelled) return
          const next = new Map<string, WrapperRun>()
          for (const [runId, run] of results) {
            if (run) next.set(runId, run)
          }
          setWrapperRuns(next)
        })
        .finally(() => {
          if (!cancelled) timer = setTimeout(poll, WRAPPER_RUN_POLL_INTERVAL_MS)
        })
    }
    poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [wrapperRunIds])

  if (runs.length === 0) return null

  const close = (): void => {
    setPinned(false)
    resetHover()
  }

  return (
    <ClickAwayListener onClickAway={close}>
      {/* Wraps the button and its list so a click on either is not "away". */}
      <Box sx={{ display: 'contents' }}>
        <ButtonBase
          ref={setAnchor}
          onMouseEnter={hover.onEnter}
          onMouseLeave={hover.onLeave}
          onClick={() => {
            if (pinned) {
              close()
              return
            }
            // The clock only ticks while the list is open, so bring it up to date first.
            setNowMs(Date.now())
            setPinned(true)
          }}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={`${agentRunOverviewLabel(runs.length)}，查看详情`}
          sx={{
            position: 'absolute',
            top: 12,
            right: 16,
            zIndex: 3,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            height: 28,
            px: 1.25,
            borderRadius: 14,
            color: 'text.primary',
            bgcolor: 'background.paper',
            border: 1,
            borderColor: open ? 'primary.main' : 'divider',
            boxShadow: 1,
            '&:hover': { borderColor: 'primary.main' },
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
          }}
        >
          <CircularProgress
            size={12}
            thickness={5}
            color="inherit"
            aria-hidden="true"
            sx={{
              color: 'primary.main',
              '@media (prefers-reduced-motion: reduce)': { animation: 'none' }
            }}
          />
          <Typography variant="caption" sx={{ fontWeight: 600, lineHeight: 1 }}>
            {agentRunOverviewLabel(runs.length)}
          </Typography>
        </ButtonBase>
        {/* A Popper, not a Popover: a Popover puts a page-wide backdrop under itself, which
            would take the hover away from the button the moment it opened. Rendered in place
            (not in a portal) so the keyboard reaches the list right after the button. */}
        <Popper
          open={open}
          anchorEl={anchor}
          placement="bottom-end"
          disablePortal
          modifiers={[{ name: 'offset', options: { offset: [0, 4] } }]}
          sx={{ zIndex: 4 }}
        >
          <Paper
            elevation={8}
            onMouseEnter={hover.onEnter}
            onMouseLeave={hover.onLeave}
            sx={{
              width: 'min(420px, calc(100vw - 32px))',
              maxHeight: '60vh',
              p: 0.75,
              overflowY: 'auto'
            }}
          >
            <Typography
              variant="caption"
              component="div"
              sx={{ px: 1, pt: 0.5, pb: 0.5, color: 'text.secondary', fontWeight: 600 }}
            >
              运行中的 Agent
            </Typography>
            <Box
              component="ul"
              sx={{ m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}
            >
              {runs.map((run) => (
                <AgentRunRow
                  key={run.id}
                  run={run}
                  wrapperRun={run.wrapperRunId ? wrapperRuns.get(run.wrapperRunId) : undefined}
                  nowMs={nowMs}
                  onLocate={(id) => {
                    close()
                    onLocate(id)
                  }}
                />
              ))}
            </Box>
          </Paper>
        </Popper>
      </Box>
    </ClickAwayListener>
  )
}

export default memo(AgentRunsOverview)
