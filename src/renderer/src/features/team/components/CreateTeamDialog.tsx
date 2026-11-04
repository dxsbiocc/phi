import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material'

import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'

export function CreateTeamDialog({
  open,
  name,
  busy,
  onNameChange,
  onClose,
  onSubmit
}: {
  open: boolean
  name: string
  busy: boolean
  onNameChange: (name: string) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{teamCopy.createTeamTitle}</DialogTitle>
      <DialogContent sx={{ pt: '8px !important' }}>
        <TextField
          autoFocus
          fullWidth
          label={teamCopy.teamName}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{teamCopy.cancel}</Button>
        <Button variant="contained" disabled={busy || !name.trim()} onClick={onSubmit}>
          {teamCopy.createTeam}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
