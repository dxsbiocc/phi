import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField
} from '@mui/material'
import type { TeamAdminMember } from '../../../../../shared/teamPackTypes'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import { teamErrorText } from '../lib/teamErrors'

export function AddAdminMemberDialogView({
  open,
  displayName,
  recipient,
  busy,
  errorCode,
  onDisplayNameChange,
  onRecipientChange,
  onClose,
  onSubmit
}: {
  open: boolean
  displayName: string
  recipient: string
  busy: boolean
  errorCode: string | null
  onDisplayNameChange: (value: string) => void
  onRecipientChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  useUiLanguage()
  const error = teamErrorText(errorCode)
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{teamCopy.addMember}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField
            autoFocus
            label={teamCopy.displayName}
            value={displayName}
            onChange={(event) => onDisplayNameChange(event.target.value)}
          />
          <TextField
            label={teamCopy.memberPublicKeyInput}
            value={recipient}
            onChange={(event) => onRecipientChange(event.target.value)}
            helperText={teamCopy.memberPublicKeyInputHint}
            multiline
            minRows={2}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{teamCopy.cancel}</Button>
        <Button
          variant="contained"
          disabled={busy || !displayName.trim() || !recipient.trim()}
          onClick={onSubmit}
        >
          {teamCopy.addMember}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export function RemoveAdminMemberDialog({
  member,
  busy,
  onClose,
  onConfirm
}: {
  member: TeamAdminMember | null
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <ConfirmationDialog open={member !== null} onClose={busy ? undefined : onClose}>
      <DialogTitle>{member ? teamCopy.removeMemberTitle(member.displayName) : ''}</DialogTitle>
      <DialogContent>
        <Alert severity="warning">{teamCopy.removeMemberWarning}</Alert>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{teamCopy.cancel}</Button>
        <Button color="error" variant="contained" disabled={busy} onClick={onConfirm}>
          {teamCopy.removeMember}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
