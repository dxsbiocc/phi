import { chatCopy } from '../lib/chatCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Collapse, Typography } from '@mui/material'
import { useId, useState, type ReactNode } from 'react'

import { PhiIcons } from '../../../icons'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler
} from '../../../components/chat/useCollapseResizeNotifier'
import {
  approvalSummaryPreview,
  type ApprovalDetails as ApprovalRecord
} from '../lib/approvalTimeline'
import { nestedFoldChevronRevealSx } from '../lib/nestedFoldChevronStyles'

const ChevronIcon = PhiIcons.action.back
const APPROVAL_ICONS = {
  pending: PhiIcons.state.pending,
  approved: PhiIcons.state.done,
  denied: PhiIcons.state.denied,
  cancelled: PhiIcons.state.abandoned
} as const satisfies Record<ApprovalRecord['status'], typeof PhiIcons.state.done>
const APPROVAL_ICON_COLORS: Record<ApprovalRecord['status'], string> = {
  pending: 'warning.main',
  approved: 'text.secondary',
  denied: 'error.main',
  cancelled: 'text.secondary'
}

/** The full command stays available without expanding the timeline or hiding approval actions. */
export function ApprovalDetails({
  summary,
  status,
  label = chatCopy.viewDetails,
  onContentResize
}: {
  summary: string
  status: ApprovalRecord['status']
  label?: ReactNode
  onContentResize?: ChatContentResizeHandler
}): React.JSX.Element {
  useUiLanguage()
  const [expanded, setExpanded] = useState(false)
  const ApprovalIcon = APPROVAL_ICONS[status]
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
          transition: 'color 150ms',
          ...nestedFoldChevronRevealSx,
          '&:hover': { color: 'text.primary' },
          '&:hover .phi-approval-preview': { color: 'text.primary' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <Box
          component="span"
          data-phi-approval-icon={status}
          sx={{
            width: 18,
            height: 18,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <ApprovalIcon aria-hidden sx={{ fontSize: 16, color: APPROVAL_ICON_COLORS[status] }} />
        </Box>
        <Typography component="span" variant="body2" sx={{ flexShrink: 0, fontWeight: 600 }}>
          {label}
        </Typography>
        <Typography
          component="span"
          variant="body2"
          className="phi-approval-preview"
          noWrap
          sx={{ minWidth: 0, color: 'text.secondary', transition: 'color 150ms' }}
        >
          {approvalSummaryPreview(summary)}
        </Typography>
        <ChevronIcon
          className="phi-nested-fold-chevron"
          data-phi-approval-chevron="true"
          aria-hidden
          sx={{
            fontSize: 16,
            flexShrink: 0,
            transform: expanded ? 'rotate(90deg)' : 'none'
          }}
        />
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
          {summary || chatCopy.noFurtherDetails}
        </Typography>
      </Collapse>
    </Box>
  )
}
