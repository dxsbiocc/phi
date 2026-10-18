import { chatCopy } from '../lib/chatCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Box, Paper, Typography } from '@mui/material'

import type { PlanReviewItem } from '../../../types'
import MarkdownContent from '../../../components/MarkdownContent'

const STATUS_LABEL: Record<PlanReviewItem['status'], string> = {
  get pending() {
    return chatCopy.awaitingReview
  },
  get approved() {
    return chatCopy.approvedToExecute
  },
  get revise() {
    return chatCopy.changesRequested
  },
  get cancelled() {
    return chatCopy.cancelled
  }
}

export function PlanReviewCard({
  item,
  cwd
}: {
  item: PlanReviewItem
  cwd: string
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Paper
      variant="outlined"
      aria-label={chatCopy.planReviewHistory}
      sx={{ mx: 1, my: 0.75, p: 1.5, borderRadius: 2, minWidth: 0 }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {chatCopy.plan} {item.title}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {STATUS_LABEL[item.status]}
      </Typography>
      <Box sx={{ mt: 1, maxHeight: 320, overflowY: 'auto' }}>
        <MarkdownContent text={item.content} cwd={cwd} />
      </Box>
      {item.note && (
        <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>
          {chatCopy.revisionNotes}
          {item.note}
        </Typography>
      )}
    </Paper>
  )
}
