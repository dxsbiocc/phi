import { Alert, Button, DialogActions, DialogContent, DialogTitle } from '@mui/material'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import type { TeamSourceView } from '../lib/teamTypes'

export function RemoveTeamSourceDialog({
  source,
  busy,
  onClose,
  onConfirm
}: {
  source: TeamSourceView | null
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <ConfirmationDialog open={source !== null} onClose={busy ? undefined : onClose}>
      <DialogTitle>{source ? teamCopy.removeTeamTitle(source.teamName) : ''}</DialogTitle>
      <DialogContent>
        <Alert severity="warning">{teamCopy.removeTeamWarning}</Alert>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{teamCopy.cancel}</Button>
        <Button color="error" variant="contained" disabled={busy} onClick={onConfirm}>
          {teamCopy.remove}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
