import { analysisCopy } from '../lib/analysisUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import {
  Alert,
  Button,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack
} from '@mui/material'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'

export function NotebookJupyterStartDialog({
  open,
  remote,
  starting,
  error,
  onClose,
  onStart
}: {
  open: boolean
  remote: boolean
  starting: boolean
  error?: string | null
  onClose: () => void
  onStart: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <ConfirmationDialog open={open} onClose={onClose} data-phi-notebook-jupyter-start-dialog="true">
      <DialogTitle>{analysisCopy.startJupyterForCellTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <DialogContentText>{analysisCopy.startJupyterForCellDescription}</DialogContentText>
          {remote && (
            <DialogContentText>{analysisCopy.startJupyterForCellRemoteNote}</DialogContentText>
          )}
          {starting && (
            <Stack direction="row" spacing={1} role="status" sx={{ alignItems: 'center' }}>
              <CircularProgress size={16} />
              <DialogContentText>{analysisCopy.startJupyterForCellProgress}</DialogContentText>
            </Stack>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{analysisCopy.close}</Button>
        <Button variant="contained" disabled={starting} onClick={onStart}>
          {analysisCopy.startJupyterForCellAction}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
