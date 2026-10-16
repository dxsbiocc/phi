import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'

import type {
  AgentNameConflictChoice,
  AgentNameConflictNotice
} from '../../../../../shared/agentNameConflictTypes'

export interface AgentNameConflictDialogProps {
  notice: AgentNameConflictNotice | null
  busy: boolean
  onResolve: (choice: AgentNameConflictChoice) => void
}

export default function AgentNameConflictDialog({
  notice,
  busy,
  onResolve
}: AgentNameConflictDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={Boolean(notice)}
      aria-labelledby="agent-name-conflict-title"
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle id="agent-name-conflict-title">Agent name conflict</DialogTitle>
      <DialogContent>
        {notice && (
          <Stack spacing={1.5}>
            <DialogContentText>
              {notice.hostAlias} has a project agent named {notice.requestedName} that shadows Phi
              agent {notice.phiAgentName}.
            </DialogContentText>
            <Typography
              component="code"
              variant="body2"
              sx={{ overflowWrap: 'anywhere', color: 'text.secondary' }}
            >
              {notice.filePath}
            </Typography>
            <DialogContentText>
              Choose which definition to rename. Phi will change only the confirmed frontmatter
              name; choosing “Not now” disables this Phi agent only for the current conversation.
            </DialogContentText>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap' }}>
        <Button disabled={busy} onClick={() => onResolve('not_now')}>
          Not now
        </Button>
        <Button disabled={busy} onClick={() => onResolve('rename_other')}>
          Rename other to {notice?.proposedOtherName}
        </Button>
        <Button disabled={busy} variant="contained" onClick={() => onResolve('rename_phi')}>
          Rename Phi to {notice?.proposedPhiName}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
