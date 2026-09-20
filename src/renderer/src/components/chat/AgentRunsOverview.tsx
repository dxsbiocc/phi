import {
  Box,
  ButtonBase,
  Chip,
  CircularProgress,
  IconButton,
  Popover,
  Tooltip,
  Typography
} from '@mui/material'
import { memo, useEffect, useState, type ReactNode } from 'react'
import { PhiIcons } from '../../icons'
import { isAgentRunGoneError } from '../../lib/agentExecutionControl'
import {
  agentRunLostKey,
  agentRunOverviewLabel,
  formatAgentDuration,
  type AgentRunOverviewEntry
} from '../../lib/agentRunsOverview'
import { useLostAgentRunsStore } from '../../stores/lostAgentRunsStore'

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
  nowMs: number
  onLocate: (id: string) => void
}

function AgentRunRow({ run, nowMs, onLocate }: AgentRunRowProps): ReactNode {
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

/**
 * A small button over the chat's top-right corner that says how many agents are running and,
 * on click, lists them with what each is doing, a way to stop it, and a way to jump to its
 * card in the conversation. Renders nothing while no agent is running.
 */
function AgentRunsOverview({ runs, onLocate }: AgentRunsOverviewProps): ReactNode {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const open = anchor !== null && runs.length > 0

  useEffect(() => {
    if (!open) return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  if (runs.length === 0) return null

  const close = (): void => setAnchor(null)

  return (
    <>
      <ButtonBase
        onClick={(event) => {
          // The clock only ticks while the list is open, so bring it up to date first.
          setNowMs(Date.now())
          setAnchor(event.currentTarget)
        }}
        aria-haspopup="dialog"
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
          borderColor: 'divider',
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
      <Popover
        open={open}
        anchorEl={anchor}
        onClose={close}
        // The chat keeps scrolling behind it, and locking scroll would shift its layout.
        disableScrollLock
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.75,
              width: 'min(420px, calc(100vw - 32px))',
              maxHeight: '60vh',
              p: 0.75,
              overflowY: 'auto'
            }
          }
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
              nowMs={nowMs}
              onLocate={(id) => {
                close()
                onLocate(id)
              }}
            />
          ))}
        </Box>
      </Popover>
    </>
  )
}

export default memo(AgentRunsOverview)
