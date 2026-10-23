import { useUiLanguage } from '../../../lib/i18n'
import { Box } from '@mui/material'

import type { ChatMessage } from '../../../types'
import type { ChatContentResizeHandler } from '../../../components/chat/useCollapseResizeNotifier'
import { APPROVAL_STATUS_LABELS } from '../lib/approvalTimeline'
import { ApprovalDetails } from './ApprovalDetails'

export function ApprovalTimelineCard({
  message,
  onContentResize
}: {
  message: ChatMessage & { approval: NonNullable<ChatMessage['approval']> }
  onContentResize?: ChatContentResizeHandler
}): React.JSX.Element {
  useUiLanguage()
  const approval = message.approval
  return (
    <Box
      data-phi-approval-state={approval.status}
      role={approval.status === 'denied' ? 'alert' : 'status'}
      sx={{
        alignSelf: 'stretch',
        minWidth: 0,
        color: approval.status === 'denied' ? 'error.main' : 'text.secondary'
      }}
    >
      <ApprovalDetails
        summary={approval.summary}
        status={approval.status}
        label={`${APPROVAL_STATUS_LABELS[approval.status]} · ${approval.toolName}`}
        onContentResize={onContentResize}
      />
    </Box>
  )
}
