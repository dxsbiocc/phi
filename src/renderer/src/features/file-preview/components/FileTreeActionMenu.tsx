import { filePreviewCopy } from '../lib/filePreviewUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import {
  Alert,
  Button,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Snackbar,
  TextField,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../../icons'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import type { FileTreeActionDialog, FileTreeMenuTarget } from '../hooks/useFileTreeActions'
import { fileTreeDisplayPath, type FileTreeAction } from '../lib/fileTreeActions'

export type FileTreeActionMenuProps = {
  menu: FileTreeMenuTarget | null
  actions: FileTreeAction[]
  onCloseMenu: () => void
  onAction: (action: FileTreeAction) => void
  dialog: FileTreeActionDialog | null
  newName: string
  onNameChange: (name: string) => void
  busy: boolean
  error: string
  onCloseDialog: () => void
  onSubmit: () => void
  notice: string
  onCloseNotice: () => void
}

export function FileTreeActionMenu({
  menu,
  actions,
  onCloseMenu,
  onAction,
  dialog,
  newName,
  onNameChange,
  busy,
  error,
  onCloseDialog,
  onSubmit,
  notice,
  onCloseNotice
}: FileTreeActionMenuProps): React.JSX.Element {
  useUiLanguage()
  const actionDetails = {
    open: { label: filePreviewCopy.open, Icon: PhiIcons.action.openDefault },
    download: { label: filePreviewCopy.download, Icon: PhiIcons.action.download },
    reveal: { label: filePreviewCopy.reveal, Icon: PhiIcons.entity.folder },
    copy: { label: filePreviewCopy.copyPath, Icon: PhiIcons.action.copy },
    rename: { label: filePreviewCopy.rename, Icon: PhiIcons.action.edit },
    delete: { label: filePreviewCopy.delete, Icon: PhiIcons.action.delete }
  }
  const rename = dialog?.mode === 'rename'
  const remote = dialog?.entry.path.startsWith('ssh://')
  return (
    <>
      <Menu
        open={Boolean(menu)}
        onClose={onCloseMenu}
        anchorReference="anchorPosition"
        anchorPosition={menu?.position}
        slotProps={{
          paper: { sx: { width: 240, maxWidth: 'calc(100vw - 32px)' } },
          list: { 'aria-label': filePreviewCopy.fileActions }
        }}
      >
        {actions.map((action) => {
          const { label, Icon } = actionDetails[action]
          return [
            action === 'rename' || (action === 'delete' && !actions.includes('rename')) ? (
              <Divider key={`${action}-divider`} />
            ) : null,
            <MenuItem
              key={action}
              onClick={() => onAction(action)}
              sx={action === 'delete' ? { color: 'error.main' } : undefined}
            >
              <ListItemIcon sx={action === 'delete' ? { color: 'error.main' } : undefined}>
                <Icon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{label}</ListItemText>
            </MenuItem>
          ]
        })}
      </Menu>
      <ConfirmationDialog open={Boolean(dialog)} onClose={onCloseDialog}>
        <DialogTitle>{rename ? filePreviewCopy.rename : filePreviewCopy.confirmDelete}</DialogTitle>
        <DialogContent>
          {rename ? (
            <TextField
              autoFocus
              fullWidth
              label={filePreviewCopy.name}
              value={newName}
              disabled={busy}
              onChange={(event) => onNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  onSubmit()
                }
              }}
              error={Boolean(error)}
              helperText={error || filePreviewCopy.noOverwrite}
              sx={{ mt: 1 }}
            />
          ) : (
            <>
              <DialogContentText>
                {remote ? filePreviewCopy.permanentDelete : filePreviewCopy.moveToTrash}
                {dialog?.entry.kind === 'directory' ? filePreviewCopy.andContents : ''}
                {'. '}
                {remote ? filePreviewCopy.irreversible : ''}
              </DialogContentText>
              <Typography variant="body2" sx={{ mt: 1.5, overflowWrap: 'anywhere' }}>
                {dialog && fileTreeDisplayPath(dialog.entry)}
              </Typography>
              {error && (
                <Alert severity="error" sx={{ mt: 1.5 }}>
                  {error}
                </Alert>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={onCloseDialog}>
            {filePreviewCopy.cancel}
          </Button>
          <Button
            disabled={busy}
            onClick={onSubmit}
            color={rename ? 'primary' : 'error'}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {rename ? filePreviewCopy.save : filePreviewCopy.delete}
          </Button>
        </DialogActions>
      </ConfirmationDialog>
      <Snackbar open={Boolean(notice)} autoHideDuration={6000} onClose={onCloseNotice}>
        <Alert severity="error" onClose={onCloseNotice}>
          {notice}
        </Alert>
      </Snackbar>
    </>
  )
}
