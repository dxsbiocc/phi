import { chatCopy } from '../features/chat/lib/chatCopy'
import { nestedFoldChevronRevealSx } from '../features/chat/lib/nestedFoldChevronStyles'
import { useUiLanguage } from '../lib/i18n'
import {
  Box,
  Button,
  Collapse,
  Divider,
  IconButton,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { memo, useEffect, useState, type ReactNode } from 'react'
import { PhiIcons, fileIconForPath } from '../icons'
import type { AgentExecutionItem } from '../types'
import {
  agentRunControlTarget,
  agentRunStatusText,
  isAgentRunGoneError,
  type AgentRunControlTarget
} from '../lib/agentExecutionControl'
import { agentRunLostKey, formatAgentDuration } from '../lib/agentRunsOverview'
import { useLostAgentRunsStore } from '../stores/lostAgentRunsStore'
import { formatBytes, outputPreviewText } from '../lib/toolOutputPresentation'
import AgentStepRow from './AgentStepRow'
import MarkdownContent, { type LocalPathKind } from './MarkdownContent'
import { StatusIndicator } from './ToolCallCard'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler
} from './chat/useCollapseResizeNotifier'
import { TimelineRail } from './chat/TimelineRail'
import { errorMessage } from '../../../shared/errorCodes'

const AgentIcon = PhiIcons.entity.agent
const ChevronRightIcon = PhiIcons.action.back
const ExpandLessIcon = PhiIcons.action.collapse
const SendIcon = PhiIcons.action.send
const StopIcon = PhiIcons.action.stop
const AGENT_EXECUTION_DETAIL_MAX_HEIGHT = 'min(560px, calc(100vh - 220px))'

function timestampMs(value?: string): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function elapsedMs(item: AgentExecutionItem, nowMs: number): number {
  if (item.status !== 'running' && typeof item.durationMs === 'number') {
    return Math.max(0, item.durationMs)
  }
  const start = timestampMs(item.createdAt)
  const end = item.status === 'running' ? nowMs : timestampMs(item.completedAt)
  if (start !== null && end !== null) return Math.max(0, end - start)
  return 0
}

function currentStepIndex(item: AgentExecutionItem): number {
  const runningIndex = item.steps.findIndex((step) => step.status === 'running')
  if (runningIndex >= 0) return runningIndex
  return item.steps.length > 0 ? item.steps.length - 1 : -1
}

function errorText(error: unknown): string {
  const message = errorMessage(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Lets the user redirect the running agent; it reads the message after its current tool call. */
function AgentRunSteerBox({
  target,
  toolCallId,
  onGone
}: {
  target: AgentRunControlTarget
  /** The card's own tool call: the main process records the message on it. */
  toolCallId: string
  onGone: () => void
}): ReactNode {
  useUiLanguage()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const submit = async (): Promise<void> => {
    const message = text.trim()
    if (!message || pending) return
    setPending(true)
    setError('')
    try {
      await window.api.steerAgentRun(target.agentSessionId, target.agentRunId, message, toolCallId)
      setText('')
    } catch (steerError) {
      if (isAgentRunGoneError(steerError)) onGone()
      else setError(errorText(steerError))
    } finally {
      setPending(false)
    }
  }

  return (
    <Box sx={{ mt: 1.25, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <TextField
          size="small"
          fullWidth
          value={text}
          disabled={pending}
          placeholder={chatCopy.additionalInstructionsWillBeReadAfterTheCurrentToolCall}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter also confirms a candidate while typing with an input method.
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void submit()
          }}
          slotProps={{
            htmlInput: { 'aria-label': chatCopy.additionalInstructionsForAgent, maxLength: 4000 }
          }}
        />
        <Tooltip title={chatCopy.send} enterDelay={400}>
          <span>
            <IconButton
              size="small"
              aria-label={chatCopy.sendInstructions}
              disabled={pending || !text.trim()}
              onClick={() => void submit()}
              sx={{ width: 32, height: 32 }}
            >
              <SendIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      {error ? (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, color: 'error.main' }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  )
}

/** What the user told the agent while it ran; part of the card's history, so it outlives the run. */
function AgentSteerHistory({ item }: { item: AgentExecutionItem }): ReactNode {
  useUiLanguage()
  if (!item.steers || item.steers.length === 0) return null
  return (
    <Box sx={{ mt: 1.25, minWidth: 0 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
        {chatCopy.yourAdditionalInstructions}
      </Typography>
      {item.steers.map((steer, index) => (
        <Typography
          key={`${index}-${steer.createdAt ?? ''}`}
          variant="body2"
          component="div"
          sx={{
            mt: 0.25,
            color: 'text.secondary',
            overflowWrap: 'anywhere',
            whiteSpace: 'pre-wrap'
          }}
        >
          {steer.text}
        </Typography>
      ))}
    </Box>
  )
}

function SavedFinalReportBlock({ item }: { item: AgentExecutionItem }): ReactNode {
  useUiLanguage()
  if (!item.finalReportTruncated || !item.finalReportPath) return null
  const icon = fileIconForPath(item.finalReportPath)
  const OutputFileIcon = icon.Icon
  return (
    <Box
      sx={{
        mb: 1.25,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minWidth: 0,
        flexWrap: 'wrap'
      }}
    >
      <OutputFileIcon sx={{ color: icon.color, fontSize: 22 }} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {chatCopy.fullReportSaved}
        </Typography>
        <Typography
          variant="caption"
          component="div"
          sx={{
            mt: 0.25,
            minWidth: 0,
            fontFamily: 'var(--font-mono)',
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={item.finalReportPath}
        >
          {item.finalReportPath}
        </Typography>
      </Box>
      <Button
        size="small"
        variant="outlined"
        onClick={() => {
          void window.api.revealPath(item.finalReportPath as string).catch((error) => {
            console.error('Failed to reveal agent report:', error)
          })
        }}
      >
        {chatCopy.revealInFolder}
      </Button>
    </Box>
  )
}

type AgentExecutionCardProps = {
  item: AgentExecutionItem
  cwd?: string
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onContentResize?: ChatContentResizeHandler
}

function AgentExecutionCard({
  item,
  cwd = '',
  onOpenLocalPath,
  onContentResize
}: AgentExecutionCardProps): React.JSX.Element {
  useUiLanguage()
  const [expanded, setExpanded] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // The agent worker no longer has this run (e.g. Phi was restarted): stop offering controls.
  // Remembered in a shared store, so the running-agents overview stops listing it too.
  const lostKey =
    item.agentRunId && item.agentSessionId
      ? agentRunLostKey({ agentRunId: item.agentRunId, agentSessionId: item.agentSessionId })
      : null
  const lost = useLostAgentRunsStore((state) => lostKey !== null && state.lost.has(lostKey))
  const markLost = useLostAgentRunsStore((state) => state.markLost)
  const setLost = (): void => {
    if (lostKey) markLost(lostKey)
  }
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const notifyContentResize = useCollapseResizeNotifier(onContentResize)
  const isRunning = item.status === 'running' && !lost
  const leadingIconKind = item.cancelled
    ? 'cancelled'
    : lost || item.status !== 'done'
      ? 'status'
      : 'type'
  const controlTarget = agentRunControlTarget(item, { lost })
  const stepIndex = currentStepIndex(item)
  const currentStep = stepIndex >= 0 ? item.steps[stepIndex] : null
  const elapsed = formatAgentDuration(elapsedMs(item, nowMs))
  const finalReport = item.finalReport
    ? outputPreviewText({
        output: item.finalReport,
        outputPath: item.finalReportPath,
        outputTruncated: item.finalReportTruncated
      })
    : ''

  useEffect(() => {
    if (!isRunning) return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isRunning])

  const toggle = (): void => {
    setExpanded((value) => !value)
    notifyContentResize()
  }

  const stop = (target: AgentRunControlTarget): void => {
    setStopping(true)
    setStopError('')
    window.api
      .stopAgentRun(target.agentSessionId, target.agentRunId)
      .catch((error: unknown) => {
        if (isAgentRunGoneError(error)) setLost()
        else setStopError(errorText(error))
      })
      .finally(() => setStopping(false))
  }

  return (
    <Box data-agent-card-id={item.id} sx={{ alignSelf: 'stretch', minWidth: 0, borderRadius: 1 }}>
      <Box
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggle()
          }
        }}
        aria-expanded={expanded}
        aria-label={expanded ? chatCopy.collapseAgentExecution : chatCopy.expandAgentExecution}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          py: 0.5,
          px: 0.5,
          borderRadius: 1,
          cursor: 'pointer',
          color: 'text.secondary',
          transition: 'color 150ms',
          ...nestedFoldChevronRevealSx,
          '&:hover': { color: 'text.primary' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <Box
          data-phi-agent-leading-icon={leadingIconKind}
          aria-live={isRunning ? 'polite' : undefined}
          sx={{
            width: 18,
            height: 18,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {leadingIconKind === 'cancelled' ? (
            <StopIcon
              sx={{ fontSize: 14, color: 'text.secondary' }}
              aria-label={chatCopy.cancelled}
            />
          ) : leadingIconKind === 'status' ? (
            <StatusIndicator status={lost ? 'error' : item.status} />
          ) : (
            <AgentIcon aria-hidden sx={{ fontSize: 16, color: 'primary.main' }} />
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 0 }}>
          <Box sx={{ flex: '0 1 auto', minWidth: 0 }}>
            <Typography component="div" variant="body2" noWrap sx={{ color: 'text.primary' }}>
              {chatCopy.delegatedTo} {item.agentName}
              {item.task ? `：${item.task}` : ''}
            </Typography>
            <Typography component="div" variant="caption" noWrap sx={{ color: 'inherit' }}>
              {agentRunStatusText(item, { lost })} {chatCopy.duration} {elapsed} {chatCopy.steps}
              {item.steps.length > 0 ? `${stepIndex + 1}/${item.steps.length}` : '0/0'}
              {currentStep ? chatCopy.currentValue2(currentStep.toolName) : ''}
            </Typography>
          </Box>
          <ChevronRightIcon
            className="phi-nested-fold-chevron"
            data-phi-agent-chevron="true"
            aria-hidden
            sx={{
              fontSize: 16,
              flexShrink: 0,
              transform: expanded ? 'rotate(90deg)' : 'none'
            }}
          />
        </Box>
        {item.toolCalls !== undefined ? (
          <Typography variant="caption" sx={{ flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
            {chatCopy.valueToolCalls(item.toolCalls)}
          </Typography>
        ) : null}
        {controlTarget ? (
          <Tooltip title={chatCopy.stopThisAgent} enterDelay={400}>
            <span>
              <IconButton
                size="small"
                aria-label={chatCopy.stopAgent}
                disabled={stopping}
                onClick={(event) => {
                  event.stopPropagation()
                  stop(controlTarget)
                }}
                onKeyDown={(event) => event.stopPropagation()}
                sx={{ width: 24, height: 24, color: 'error.main' }}
              >
                <StopIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
      </Box>
      <Collapse
        in={expanded}
        unmountOnExit
        onEnter={notifyContentResize}
        onEntering={notifyContentResize}
        onEntered={notifyContentResize}
        onExit={notifyContentResize}
        onExiting={notifyContentResize}
        onExited={notifyContentResize}
      >
        <Box
          data-phi-agent-execution-scroll="true"
          tabIndex={0}
          sx={{
            maxHeight: AGENT_EXECUTION_DETAIL_MAX_HEIGHT,
            overflowY: 'auto',
            overflowX: 'hidden',
            pr: 0.5,
            outline: 'none',
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
          }}
        >
          <TimelineRail active={isRunning} sx={{ py: 1 }}>
            {item.argsJson ? (
              <Box sx={{ mb: 1.25, minWidth: 0 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                  {chatCopy.delegatedTaskArguments}
                </Typography>
                <Typography
                  component="pre"
                  variant="body2"
                  sx={{
                    m: 0,
                    mt: 0.5,
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8rem',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    color: 'text.secondary'
                  }}
                >
                  {item.argsJson}
                </Typography>
              </Box>
            ) : null}
            {item.steps.length > 0 ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
                {item.steps.map((step) => (
                  <AgentStepRow
                    key={step.id}
                    step={step}
                    cwd={cwd}
                    onContentResize={onContentResize}
                  />
                ))}
              </Box>
            ) : (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {chatCopy.waitingForInternalToolSteps}
              </Typography>
            )}
            <AgentSteerHistory item={item} />
            {controlTarget ? (
              <AgentRunSteerBox target={controlTarget} toolCallId={item.id} onGone={setLost} />
            ) : null}
            {stopError ? (
              <Typography variant="caption" component="div" sx={{ mt: 0.5, color: 'error.main' }}>
                {stopError}
              </Typography>
            ) : null}
            {lost ? (
              <Typography variant="caption" component="div" sx={{ mt: 1, color: 'text.secondary' }}>
                {chatCopy.thisAgentIsNoLongerRunningPhiMayHaveRestarted}
              </Typography>
            ) : null}
            {finalReport ? (
              <>
                <Divider sx={{ my: 1.25 }} />
                <SavedFinalReportBlock item={item} />
                <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                  {chatCopy.finalReport}
                  {item.finalReportBytes ? ` · ${formatBytes(item.finalReportBytes)}` : ''}
                  {item.finalReportTruncated ? chatCopy.truncated : ''}
                </Typography>
                <Box sx={{ mt: 0.5 }}>
                  <MarkdownContent text={finalReport} cwd={cwd} onOpenLocalPath={onOpenLocalPath} />
                </Box>
              </>
            ) : null}
            {item.error ? (
              <Typography
                variant="caption"
                component="div"
                sx={{
                  mt: 1,
                  color: 'error.main',
                  fontFamily: 'var(--font-mono)',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere'
                }}
              >
                {item.error}
              </Typography>
            ) : null}
            <Box sx={{ display: 'flex', justifyContent: 'flex-start', pt: 0.5 }}>
              <Tooltip title={chatCopy.collapseAgentExecution} enterDelay={400}>
                <IconButton
                  size="small"
                  aria-label={chatCopy.collapseAgentExecution}
                  onClick={toggle}
                  sx={{ width: 28, height: 28, color: 'text.secondary' }}
                >
                  <ExpandLessIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </TimelineRail>
        </Box>
      </Collapse>
    </Box>
  )
}

function agentExecutionCardPropsEqual(
  prev: AgentExecutionCardProps,
  next: AgentExecutionCardProps
): boolean {
  return (
    prev.item === next.item &&
    prev.cwd === next.cwd &&
    prev.onOpenLocalPath === next.onOpenLocalPath &&
    prev.onContentResize === next.onContentResize
  )
}

export default memo(AgentExecutionCard, agentExecutionCardPropsEqual)
