import { Box, Collapse, Typography } from '@mui/material'
import { useId, useState, type ReactNode } from 'react'

import { PhiIcons } from '../../../icons'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler
} from '../../../components/chat/useCollapseResizeNotifier'
import { approvalSummaryPreview } from '../lib/approvalTimeline'

const ChevronIcon = PhiIcons.action.back

/** The full command stays available without expanding the timeline or hiding approval actions. */
export function ApprovalDetails({
  summary,
  label = '查看详情',
  onContentResize
}: {
  summary: string
  label?: ReactNode
  onContentResize?: ChatContentResizeHandler
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const notifyResize = useCollapseResizeNotifier(onContentResize)
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box
        component="button"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => {
          setExpanded((value) => !value)
          notifyResize()
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          maxWidth: '100%',
          width: '100%',
          p: 0.75,
          border: 0,
          borderRadius: 1,
          bgcolor: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <ChevronIcon
          aria-hidden
          sx={{
            fontSize: 16,
            flexShrink: 0,
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(90deg)' : 'none'
          }}
        />
        <Typography component="span" variant="body2" sx={{ flexShrink: 0, fontWeight: 600 }}>
          {label}
        </Typography>
        <Typography
          component="span"
          variant="body2"
          color="text.secondary"
          noWrap
          sx={{ minWidth: 0 }}
        >
          {approvalSummaryPreview(summary)}
        </Typography>
      </Box>
      <Collapse
        in={expanded}
        unmountOnExit
        onEnter={notifyResize}
        onEntering={notifyResize}
        onEntered={notifyResize}
        onExit={notifyResize}
        onExiting={notifyResize}
        onExited={notifyResize}
      >
        <Typography
          id={detailsId}
          component="pre"
          variant="body2"
          sx={{
            m: 0,
            mt: 0.75,
            p: 1.5,
            bgcolor: 'action.hover',
            borderRadius: 1,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            maxHeight: 320,
            overflow: 'auto'
          }}
        >
          {summary || '没有更多详情。'}
        </Typography>
      </Collapse>
    </Box>
  )
}
