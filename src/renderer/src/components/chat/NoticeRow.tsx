import { Box, Collapse, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
import { chatEventCopy } from '../../features/chat/lib/chatEventCopy'
import { PhiIcons } from '../../icons'
import { useUiLanguage } from '../../lib/i18n'
import { TimelineRail } from './TimelineRail'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler
} from './useCollapseResizeNotifier'

export type NoticeLevel = 'info' | 'warning' | 'error'

const ChevronRightIcon = PhiIcons.action.back
const LEVEL_ICON = {
  info: PhiIcons.state.info,
  warning: PhiIcons.state.warning,
  error: PhiIcons.state.blocked
} as const
const LEVEL_COLOR = {
  info: 'primary.main',
  warning: 'warning.main',
  error: 'error.main'
} as const

/** Compact collapsible row shared by every app-generated notice, matching thinking/tool rows. */
export function NoticeRow({
  level,
  title,
  detail,
  children,
  onContentResize
}: {
  level: NoticeLevel
  title: string
  /** Short one-line hint appended to the title while collapsed. */
  detail?: string
  children: ReactNode
  onContentResize?: ChatContentResizeHandler
}): ReactNode {
  useUiLanguage()
  const [expanded, setExpanded] = useState(false)
  const notifyContentResize = useCollapseResizeNotifier(onContentResize)
  const Icon = LEVEL_ICON[level]
  const levelLabel = chatEventCopy.noticeLevel[level]
  const toggle = (): void => {
    setExpanded((value) => !value)
    notifyContentResize()
  }
  const separator = chatEventCopy.titleDetailSeparator

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
        data-notice-level={level}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          py: 0.5,
          px: 0.5,
          borderRadius: 1,
          cursor: 'pointer',
          color: LEVEL_COLOR[level],
          transition: 'background-color 150ms',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <ChevronRightIcon
          aria-hidden
          sx={{
            fontSize: 16,
            flexShrink: 0,
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(90deg)' : 'none'
          }}
        />
        <Icon aria-hidden sx={{ fontSize: 16, flexShrink: 0 }} />
        <Typography
          component="span"
          variant="body2"
          noWrap
          sx={{ flex: 1, minWidth: 0, color: 'inherit' }}
        >
          <Box
            component="span"
            sx={{
              position: 'absolute',
              width: 1,
              height: 1,
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)'
            }}
          >
            {levelLabel}
            {separator}
          </Box>
          {title}
          {detail ? `${separator}${detail}` : ''}
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
        <TimelineRail sx={{ py: 1 }}>{children}</TimelineRail>
      </Collapse>
    </Box>
  )
}
