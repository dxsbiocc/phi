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
      aria-label="计划等待评审"
      sx={{ width: '100%', mb: 1, p: 1.5, borderRadius: 2, minWidth: 0 }}
    >
      <Stack spacing={1.25}>
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            计划等待评审 · {plan.title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            确认前，本轮 Agent 只能探索和修改计划，不能通过本轮工具改动工作区。
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
          placeholder="需要修改时，写下调整意见"
          slotProps={{ htmlInput: { maxLength: 2000, 'aria-label': '计划修改意见' } }}
        />
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button variant="outlined" disabled={!note.trim()} onClick={() => respond('revise')}>
            修改计划
          </Button>
          <Button variant="contained" onClick={() => respond('approve')}>
            继续执行
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}
