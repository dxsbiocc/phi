import { useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
import { Button, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'

export function RemoteNextflowInstallDialog({
  open,
  installing,
  onClose,
  onConfirm
}: {
  open: boolean
  installing: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <ConfirmationDialog open={open} onClose={() => !installing && onClose()}>
      <DialogTitle>{remoteSetupCopy.installNextflow}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mt: 1 }}>
          {remoteSetupCopy.nextflowInstallConsent}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={installing}>
          {remoteSetupCopy.cancel}
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={installing}>
          {remoteSetupCopy.confirmInstall}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
