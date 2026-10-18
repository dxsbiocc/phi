import { chatCopy } from '../features/chat/lib/chatCopy'
import { useUiLanguage } from '../lib/i18n'
import { Box, Button, Paper, Stack, TextField, Typography } from '@mui/material'
import { useState } from 'react'

import type { AgentUserInteractionRequest, AgentUserInteractionResponse } from '../types'
import { planReviewResponse } from '../features/chat/lib/planReview'
import MarkdownContent from './MarkdownContent'

export function PlanReviewPanel({
  request,
  onRespond
}: {
  request: AgentUserInteractionRequest
  onRespond: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled?: boolean
  ) => void
}): React.JSX.Element | null {
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
      variant="outlined"
      role="alert"
      aria-label={chatCopy.planAwaitingReview}
      sx={{ width: '100%', mb: 1, p: 1.5, borderRadius: 2, minWidth: 0 }}
    >
      <Stack spacing={1.25}>
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {chatCopy.planAwaitingReview2} {plan.title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {chatCopy.untilYouApproveTheAgentCanOnlyExploreAndRevise}
          </Typography>
        </Box>
        <Box
          sx={{
            maxHeight: 320,
            overflowY: 'auto',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            p: 1
          }}
        >
          <MarkdownContent text={plan.content} cwd={request.cwd ?? ''} />
        </Box>
        <TextField
          size="small"
          multiline
          minRows={2}
          maxRows={4}
          value={note}
          onChange={(event) => setDraft({ requestId: request.requestId, note: event.target.value })}
          placeholder={chatCopy.enterRevisionNotesIfChangesAreNeeded}
          slotProps={{ htmlInput: { maxLength: 2000, 'aria-label': chatCopy.planRevisionNotes } }}
        />
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button variant="outlined" disabled={!note.trim()} onClick={() => respond('revise')}>
            {chatCopy.revisePlan}
          </Button>
          <Button variant="contained" onClick={() => respond('approve')}>
            {chatCopy.continueExecution}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}
