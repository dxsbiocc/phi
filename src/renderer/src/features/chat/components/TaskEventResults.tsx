import { Box, Button, IconButton, Paper, Stack, Typography } from '@mui/material'
import type { TaskEventNotice } from '../../../../../shared/taskEventTypes'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { taskEventCopy as copy } from '../lib/taskEventCopy'

export interface TaskEventReply {
  key: string
  notice: Extract<TaskEventNotice, { kind: 'approval' | 'clarify' }>
}

function TaskClarification({
  notice
}: {
  notice: Extract<TaskEventNotice, { kind: 'clarify' }>
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Stack spacing={0.5} sx={{ overflowWrap: 'anywhere' }}>
      {notice.tasks?.map((task) => (
        <Typography key={task.id} variant="caption" data-phi-task-event-id={task.id}>
          {task.preview} <code>{task.id}</code>
        </Typography>
      ))}
      {notice.tasks?.length === 0 && <Typography variant="caption">{copy.none}</Typography>}
      {notice.more && <Typography variant="caption">{copy.more}</Typography>}
      <Typography variant="caption" color="text.secondary">
        {copy.commands}
      </Typography>
    </Stack>
  )
}

export function TaskEventResults({
  reply: { key, notice },
  onDismiss,
  onDecide
}: {
  reply: TaskEventReply
  onDismiss(key: string): void
  onDecide(key: string, taskId: string, approvalId: string, action: 'approve' | 'deny'): void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Paper
      data-phi-task-event-result={notice.kind}
      variant="outlined"
      sx={{ flexShrink: 0, m: 1.5, mb: 0.5, p: 1.25, maxHeight: 240, overflowY: 'auto' }}
    >
      <Stack
        direction="row"
        sx={{ alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}
      >
        <Typography variant="body2" role="status" sx={{ fontWeight: 600 }}>
          {notice.kind === 'approval' ? copy.approval : copy.clarify[notice.reason]}
        </Typography>
        <IconButton
          type="button"
          size="small"
          aria-label={copy.close}
          onClick={() => onDismiss(key)}
        >
          <PhiIcons.action.close size={14} />
        </IconButton>
      </Stack>
      {notice.kind === 'clarify' ? (
        <TaskClarification notice={notice} />
      ) : (
        <Stack spacing={1} data-phi-task-event-id={notice.task.id}>
          {notice.requests.length === 0 && (
            <Typography variant="body2">{copy.noApproval}</Typography>
          )}
          {notice.requests.map((request) => (
            <Box key={request.id}>
              <Typography variant="subtitle2">{request.tool}</Typography>
              <Typography
                component="pre"
                variant="body2"
                sx={{
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  userSelect: 'text',
                  my: 0.5
                }}
              >
                {request.summary}
              </Typography>
              <Button
                type="button"
                size="small"
                variant="outlined"
                data-phi-task-approval-decision={request.id}
                onClick={() => onDecide(key, notice.task.id, request.id, notice.action)}
              >
                {copy[notice.action]}
              </Button>
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  )
}
