import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle
} from '@mui/material'
import type { Theme } from '@mui/material/styles'

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
      <Dialog open={deleteSessionOpen} onClose={onCancelSessionDelete} sx={previewDialogSx}>
        <DialogTitle>删除这段对话？</DialogTitle>
        <DialogContent>
          <DialogContentText>{deleteSessionTitle} 将被永久删除，无法恢复。</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancelSessionDelete} sx={{ minHeight: 44 }}>
            取消
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={onConfirmSessionDelete}
            sx={{ minHeight: 44 }}
          >
            删除
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={deleteProjectOpen} onClose={onCancelProjectDelete} sx={previewDialogSx}>
        <DialogTitle>移除这个项目？</DialogTitle>
        <DialogContent>
          <DialogContentText>
            仅从列表中移除「{deleteProjectName}」，不会删除工作目录或对话记录。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancelProjectDelete} sx={{ minHeight: 44 }}>
            取消
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={onConfirmProjectDelete}
            sx={{ minHeight: 44 }}
          >
            移除
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
