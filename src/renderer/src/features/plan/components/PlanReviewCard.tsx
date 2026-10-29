import { Box, Paper, Typography } from '@mui/material'

import type { PlanReviewItem } from '../../../types'
import { useUiLanguage } from '../../../lib/i18n'
import MarkdownContent from '../../../components/MarkdownContent'
import { planCopy } from '../lib/planCopy'
import { PlanReviewSteps } from './PlanReviewSteps'
import { PlanTimelineIcon, type PlanTimelineTone } from './PlanTimeline'

function statusLabel(status: PlanReviewItem['status']): string {
  if (status === 'pending') return planCopy.awaitingReview
  if (status === 'approved') return planCopy.approvedToExecute
  if (status === 'revise') return planCopy.changesRequested
  return planCopy.cancelled
}

function historyTone(status: PlanReviewItem['status']): PlanTimelineTone {
  if (status === 'approved') return 'success'
  if (status === 'revise' || status === 'cancelled') return 'error'
  return 'neutral'
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
      sx={{ mx: 1, my: 0.75, borderRadius: 2, minWidth: 0, overflow: 'hidden' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.75, py: 1.35 }}>
        <PlanTimelineIcon tone={historyTone(item.status)} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {planCopy.plan} {item.title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {statusLabel(item.status)}
          </Typography>
        </Box>
      </Box>
      {item.note && (
        <Typography variant="body2" sx={{ px: 1.75, whiteSpace: 'pre-wrap' }}>
          {planCopy.revisionNotes}
          {item.note}
        </Typography>
      )}
      <Box component="details" data-phi-plan-review-details sx={{ px: 1.75, pb: 1.5 }}>
        <Typography component="summary" variant="body2" sx={{ cursor: 'pointer' }}>
          {planCopy.viewPlanDetails}
        </Typography>
        <Box sx={{ mt: 1, maxHeight: 320, overflowY: 'auto' }}>
          {item.steps ? (
            <PlanReviewSteps plan={item.steps} />
          ) : (
            <MarkdownContent text={item.content} cwd={cwd} />
          )}
        </Box>
      </Box>
    </Paper>
  )
}
