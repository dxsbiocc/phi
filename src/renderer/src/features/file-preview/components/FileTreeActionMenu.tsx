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

const actionDetails = {
  open: { label: '打开', Icon: PhiIcons.action.openDefault },
  download: { label: '下载', Icon: PhiIcons.action.download },
  reveal: { label: '在文件管理器中显示', Icon: PhiIcons.entity.folder },
  copy: { label: '复制路径', Icon: PhiIcons.action.copy },
  rename: { label: '重命名', Icon: PhiIcons.action.edit },
  delete: { label: '删除', Icon: PhiIcons.action.delete }
}

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
          list: { 'aria-label': '文件操作' }
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
        <DialogTitle>{rename ? '重命名' : '删除确认'}</DialogTitle>
        <DialogContent>
          {rename ? (
            <TextField
              autoFocus
              fullWidth
              label="名称"
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
              helperText={error || '同名文件不会被覆盖'}
              sx={{ mt: 1 }}
            />
          ) : (
            <>
              <DialogContentText>
                {remote ? '将永久删除此项' : '将此项移到废纸篓'}
                {dialog?.entry.kind === 'directory' ? '及其全部内容' : ''}。
                {remote ? '此操作无法撤销。' : ''}
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
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={onSubmit}
            color={rename ? 'primary' : 'error'}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {rename ? '保存' : '删除'}
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
