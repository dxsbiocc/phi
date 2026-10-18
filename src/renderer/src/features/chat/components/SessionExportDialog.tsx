import { chatCopy } from '../lib/chatCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Alert, Button, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import type { SessionSummary } from '../../../types'

export function SessionExportDialog({
  session,
  busy,
  onClose,
  onExport
}: {
  session: SessionSummary | null
  busy: boolean
  onClose: () => void
  onExport: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <ConfirmationDialog open={session !== null} onClose={busy ? undefined : onClose}>
      <DialogTitle>{chatCopy.exportFullConversation}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {chatCopy.exportConversationDescription(
            session?.name || session?.firstMessage || chatCopy.untitledConversation
          )}
        </Typography>
        <Alert severity="warning">
          {chatCopy.thisBackupIncludesTheFullConversationThinkingToolOutputImages}
        </Alert>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          {chatCopy.filesInTheProjectWorkingDirectoryAreExcludedTheExport}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          {chatCopy.cancel}
        </Button>
        <Button disabled={busy} variant="contained" onClick={onExport}>
          {busy ? chatCopy.exporting : chatCopy.chooseLocationAndExport}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
