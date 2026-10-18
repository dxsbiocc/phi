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
  onContentResize
}: {
  content: string
  durationMs?: number
  onContentResize?: ChatContentResizeHandler
}): ReactNode {
  useUiLanguage()
  const [expanded, setExpanded] = useState(false)
  const notifyContentResize = useCollapseResizeNotifier(onContentResize)
  const toggle = (): void => {
    setExpanded((value) => !value)
    notifyContentResize()
  }
  const label = formatThinkingDuration(durationMs)

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0 }}>
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
          transition: 'background-color 150ms',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <ChevronRightIcon
          sx={{
            fontSize: 16,
            flexShrink: 0,
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(90deg)' : 'none'
          }}
        />
        <ThinkingIcon />
        <Typography component="span" variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {label}
        </Typography>
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

function ThinkingIcon({ size = 16 }: { size?: number }): ReactNode {
  useUiLanguage()
  return (
    <Tooltip title={chatCopy.thinking} enterDelay={500}>
      <Box
        component="span"
        role="img"
        aria-label={chatCopy.thinking}
        sx={{
          width: size + 2,
          height: size + 2,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary'
        }}
      >
        <PsychologyIcon sx={{ fontSize: size }} />
      </Box>
    </Tooltip>
  )
}
