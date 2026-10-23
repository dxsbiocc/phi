import { Box, Paper, Typography } from '@mui/material'

import type { PlanReviewItem } from '../../../types'
import { useUiLanguage } from '../../../lib/i18n'
import MarkdownContent from '../../../components/MarkdownContent'
import { planCopy } from '../lib/planCopy'
import { PlanReviewSteps } from './PlanReviewSteps'

function statusLabel(status: PlanReviewItem['status']): string {
  if (status === 'pending') return planCopy.awaitingReview
  if (status === 'approved') return planCopy.approvedToExecute
  if (status === 'revise') return planCopy.changesRequested
  return planCopy.cancelled
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
      aria-label={planCopy.planReviewHistory}
      sx={{ mx: 1, my: 0.75, p: 1.5, borderRadius: 2, minWidth: 0 }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {planCopy.plan} {item.title}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {statusLabel(item.status)}
      </Typography>
      <Box sx={{ mt: 1, maxHeight: 320, overflowY: 'auto' }}>
        {item.steps ? (
          <PlanReviewSteps plan={item.steps} />
        ) : (
          <MarkdownContent text={item.content} cwd={cwd} />
        )}
      </Box>
      {item.note && (
        <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>
          {planCopy.revisionNotes}
          {item.note}
        </Typography>
      )}
    </Paper>
  )
}
