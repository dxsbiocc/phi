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
        <DialogTitle>删除这段对话？</DialogTitle>
        <DialogContent>
          <DialogContentText>{deleteSessionTitle} 将被永久删除，无法恢复。</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancelSessionDelete}>取消</Button>
          <Button color="error" variant="contained" onClick={onConfirmSessionDelete}>
            删除
          </Button>
        </DialogActions>
      </ConfirmationDialog>

      <ConfirmationDialog
        open={deleteProjectOpen}
        onClose={onCancelProjectDelete}
        sx={previewDialogSx}
      >
        <DialogTitle>移除这个项目？</DialogTitle>
        <DialogContent>
          <DialogContentText>
            仅从列表中移除「{deleteProjectName}」，不会删除工作目录或对话记录。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancelProjectDelete}>取消</Button>
          <Button color="error" variant="contained" onClick={onConfirmProjectDelete}>
            移除
          </Button>
        </DialogActions>
      </ConfirmationDialog>
    </>
  )
}
