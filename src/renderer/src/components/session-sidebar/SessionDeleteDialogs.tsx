import { navigationCopy } from '../../lib/navigationCopy'
import { useUiLanguage } from '../../lib/i18n'
import { Button, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { ConfirmationDialog } from '../ConfirmationDialog'

type SessionDeleteDialogsProps = {
  deleteSessionOpen: boolean
  deleteSessionTitle: string
  deleteProjectOpen: boolean
  deleteProjectName: string
  compactHoverPreview?: boolean
  onCancelSessionDelete: () => void
  onConfirmSessionDelete: () => void
  onCancelProjectDelete: () => void
  onConfirmProjectDelete: () => void
}

export function SessionDeleteDialogs({
  deleteSessionOpen,
  deleteSessionTitle,
  deleteProjectOpen,
  deleteProjectName,
  compactHoverPreview = false,
  onCancelSessionDelete,
  onConfirmSessionDelete,
  onCancelProjectDelete,
  onConfirmProjectDelete
}: SessionDeleteDialogsProps): React.JSX.Element {
  useUiLanguage()
  const previewDialogSx = compactHoverPreview
    ? { zIndex: (theme: Theme) => theme.zIndex.tooltip + 2 }
    : undefined

  return (
    <>
      <ConfirmationDialog
        open={deleteSessionOpen}
        onClose={onCancelSessionDelete}
        sx={previewDialogSx}
      >
        <DialogTitle>{navigationCopy.deleteThisConversation}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {deleteSessionTitle} {navigationCopy.willBePermanentlyDeletedAndCannotBeRecovered}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancelSessionDelete}>{navigationCopy.cancel}</Button>
          <Button color="error" variant="contained" onClick={onConfirmSessionDelete}>
            {navigationCopy.delete}
          </Button>
        </DialogActions>
      </ConfirmationDialog>

      <ConfirmationDialog
        open={deleteProjectOpen}
        onClose={onCancelProjectDelete}
        sx={previewDialogSx}
      >
        <DialogTitle>{navigationCopy.removeThisProject}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {navigationCopy.remove}
            {deleteProjectName}
            {navigationCopy.fromTheListOnlyTheWorkingDirectoryAndConversationHistory}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancelProjectDelete}>{navigationCopy.cancel}</Button>
          <Button color="error" variant="contained" onClick={onConfirmProjectDelete}>
            {navigationCopy.remove2}
          </Button>
        </DialogActions>
      </ConfirmationDialog>
    </>
  )
}
