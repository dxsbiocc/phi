import { chatCopy } from '../../features/chat/lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
import { Box, Collapse, Tooltip, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
import { PhiIcons } from '../../icons'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler
} from './useCollapseResizeNotifier'
import { TimelineRail } from './TimelineRail'

const ChevronRightIcon = PhiIcons.action.back
const PsychologyIcon = PhiIcons.state.thinking

function formatThinkingDuration(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return chatCopy.thinking
  if (durationMs < 1000) return chatCopy.thoughtFor1S

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return chatCopy.thoughtForValueS(totalSeconds)

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0
    ? chatCopy.thoughtForValueMValueS(minutes, seconds)
    : chatCopy.thoughtForValueM(minutes)
}

export function ThinkingBlock({
  content,
  durationMs,
  isRunning = false,
  onContentResize
}: {
  content: string
  durationMs?: number
  isRunning?: boolean
  onContentResize?: ChatContentResizeHandler
}): ReactNode {
  useUiLanguage()
  const [manualExpanded, setManualExpanded] = useState<boolean | undefined>()
  const expanded = manualExpanded ?? (isRunning && content.trim().length > 0)
  const notifyContentResize = useCollapseResizeNotifier(onContentResize)
  const toggle = (): void => {
    setManualExpanded(!expanded)
    notifyContentResize()
  }
  const label = isRunning ? chatCopy.thinkingInProgress : formatThinkingDuration(durationMs)

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0 }}>
      <Box
        component="button"
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={expanded}
        data-phi-thinking-status={isRunning ? 'running' : 'complete'}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          width: '100%',
          minWidth: 0,
          py: 0.5,
          px: 0.5,
          border: 0,
          borderRadius: 1,
          bgcolor: 'transparent',
          fontFamily: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          color: isRunning ? 'primary.main' : 'text.secondary',
          transition: 'background-color 150ms',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <ThinkingIcon active={isRunning} />
        <Typography component="span" variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {label}
        </Typography>
        <ChevronRightIcon
          data-phi-thinking-chevron="true"
          sx={{
            fontSize: 16,
            flexShrink: 0,
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(90deg)' : 'none'
          }}
        />
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
        <TimelineRail sx={{ py: 1 }}>
          <Typography
            variant="body2"
            sx={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontStyle: 'italic',
              color: 'text.secondary'
            }}
          >
            {content}
          </Typography>
        </TimelineRail>
      </Collapse>
    </Box>
  )
}

function ThinkingIcon({
  size = 16,
  active = false
}: {
  size?: number
  active?: boolean
}): ReactNode {
  useUiLanguage()
  return (
    <Tooltip title={chatCopy.thinking} enterDelay={500}>
      <Box
        component="span"
        role="img"
        aria-label={chatCopy.thinking}
        data-phi-thinking-icon="true"
        sx={{
          width: size + 2,
          height: size + 2,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: active ? 'primary.main' : 'text.secondary',
          animation: active ? 'phi-thinking-pulse 1.6s ease-in-out infinite' : 'none',
          '@keyframes phi-thinking-pulse': {
            '0%, 100%': { opacity: 0.5 },
            '50%': { opacity: 1 }
          },
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' }
        }}
      >
        <PsychologyIcon sx={{ fontSize: size }} />
      </Box>
    </Tooltip>
  )
}
