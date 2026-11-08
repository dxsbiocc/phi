import { Box, IconButton, Paper, Stack, TextField, Typography } from '@mui/material'
import { useState } from 'react'

import type { AgentUserInteractionRequest, AgentUserInteractionResponse } from '../../../types'
import { useUiLanguage } from '../../../lib/i18n'
import MarkdownContent from '../../../components/MarkdownContent'
import { PhiIcons } from '../../../icons'
import { planCopy } from '../lib/planCopy'
import { planReviewResponse } from '../lib/planReview'
import { PlanReviewSteps } from './PlanReviewSteps'
import { PlanTimelineIcon } from './PlanTimeline'

type ReviewPlan = NonNullable<AgentUserInteractionRequest['planReview']>
type PlanReviewPanelProps = {
  request: AgentUserInteractionRequest
  onRespond: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled?: boolean
  ) => void
}

function ReviewHeading({ title }: { title: string }): React.JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
      <PlanTimelineIcon tone="active" spinning />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {planCopy.planAwaitingReviewTitle} {title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {planCopy.approvalBoundary}
        </Typography>
      </Box>
    </Box>
  )
}

function ReviewContent({ plan, cwd }: { plan: ReviewPlan; cwd: string }): React.JSX.Element {
  return (
    <Box data-testid="gui-e2e-plan-review-content" sx={{ maxHeight: 360, overflowY: 'auto' }}>
      {plan.steps ? (
        <PlanReviewSteps plan={plan.steps} />
      ) : (
        <MarkdownContent text={plan.content} cwd={cwd} />
      )}
    </Box>
  )
}

function ReviewActions({
  note,
  onNote,
  onRespond
}: {
  note: string
  onNote: (note: string) => void
  onRespond: (decision: 'approve' | 'revise') => void
}): React.JSX.Element {
  return (
    <>
      <TextField
        size="small"
        multiline
        minRows={1}
        maxRows={4}
        value={note}
        onChange={(event) => onNote(event.target.value)}
        placeholder={planCopy.revisionPlaceholder}
        slotProps={{ htmlInput: { maxLength: 2000, 'aria-label': planCopy.planRevisionNotes } }}
      />
      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
        <IconButton
          size="small"
          disabled={!note.trim()}
          onClick={() => onRespond('revise')}
          aria-label={planCopy.revisePlan}
          sx={{ border: '1px solid', borderColor: 'divider' }}
        >
          <PhiIcons.action.revise size={16} aria-hidden />
        </IconButton>
        <IconButton
          data-testid="gui-e2e-plan-review-approve"
          size="small"
          color="success"
          onClick={() => onRespond('approve')}
          aria-label={planCopy.approveAndStartExecution}
          sx={{ border: '1px solid', borderColor: 'success.main' }}
        >
          <PhiIcons.action.accept size={16} aria-hidden />
        </IconButton>
      </Stack>
    </>
  )
}

export function PlanReviewPanel({
  request,
  onRespond
}: PlanReviewPanelProps): React.JSX.Element | null {
  useUiLanguage()
  const [draft, setDraft] = useState({ requestId: request.requestId, note: '' })
  const plan = request.planReview
  if (!plan) return null
  const note = draft.requestId === request.requestId ? draft.note : ''
  const respond = (decision: 'approve' | 'revise'): void => {
    onRespond(request.requestId, planReviewResponse(request.requestId, decision, note))
  }

  return (
    <Paper
      data-testid="gui-e2e-plan-review"
      variant="outlined"
      role="alert"
      aria-label={planCopy.planAwaitingReview}
      sx={{ width: '100%', mb: 1, px: 1.75, py: 1.5, borderRadius: 2, minWidth: 0 }}
    >
      <Stack spacing={1.25}>
        <ReviewHeading title={plan.title} />
        <ReviewContent plan={plan} cwd={request.cwd ?? ''} />
        <ReviewActions
          note={note}
          onNote={(value) => setDraft({ requestId: request.requestId, note: value })}
          onRespond={respond}
        />
      </Stack>
    </Paper>
  )
}
