import { Box, Button, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { useUiLanguage } from '../../../lib/i18n'
import { chatCodeCopy } from '../lib/chatCodeCopy'

export function ChatShellConfirmation({
  command,
  cwd,
  onClose,
  onRun
}: {
  command: string
  cwd: string
  onClose: () => void
  onRun: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <ConfirmationDialog open onClose={onClose} aria-labelledby="chat-shell-run-title">
      <DialogTitle id="chat-shell-run-title">{chatCodeCopy.runInBackground}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary">
          {chatCodeCopy.workingDirectory}
        </Typography>
        <Typography component="div" variant="body2" sx={{ fontFamily: 'var(--font-mono)' }}>
          {cwd}
        </Typography>
        <Box
          component="pre"
          sx={{
            my: 1.5,
            p: 1.5,
            maxHeight: '40vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            bgcolor: 'action.hover',
            borderRadius: 1,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem'
          }}
        >
          {command}
        </Box>
        <Typography variant="body2" color="text.secondary">
          {chatCodeCopy.resultDestination}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button autoFocus onClick={onClose}>
          {chatCodeCopy.cancel}
        </Button>
        <Button color="warning" variant="contained" onClick={onRun}>
          {chatCodeCopy.run}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
