import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  TextField
} from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { GoX } from 'react-icons/go'

type SessionRenamePanelProps = {
  open: boolean
  title: string
  compactHoverPreview: boolean
  onTitleChange: (title: string) => void
  onClose: () => void
  onSave: () => void
}

export function SessionRenamePanel({
  open,
  title,
  compactHoverPreview,
  onTitleChange,
  onClose,
  onSave
}: SessionRenamePanelProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xs"
      aria-labelledby="session-rename-title"
      aria-describedby="session-rename-description"
      data-phi-session-rename-dialog="true"
      slotProps={{
        paper: {
          sx: {
            borderRadius: 2.5,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper'
          }
        }
      }}
      sx={compactHoverPreview ? { zIndex: (theme: Theme) => theme.zIndex.tooltip + 2 } : undefined}
    >
      <DialogTitle
        id="session-rename-title"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 3,
          pt: 2.5,
          pb: 0.5,
          fontSize: '1.25rem',
          fontWeight: 700
        }}
      >
        <Box component="span">重命名聊天</Box>
        <IconButton
          size="small"
          aria-label="关闭重命名窗口"
          onClick={onClose}
          sx={{ color: 'text.secondary' }}
        >
          <GoX aria-hidden size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ px: 3, pb: 1 }}>
        <DialogContentText id="session-rename-description" sx={{ fontSize: '0.875rem', mb: 2 }}>
          保持简短且易于识别
        </DialogContentText>
        <TextField
          autoFocus
          fullWidth
          label="对话标题"
          aria-label="新的对话标题"
          value={title}
          sx={{ '& .MuiOutlinedInput-root': { borderRadius: 1.5 } }}
          onChange={(event) => onTitleChange(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onSave()
            }
          }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pt: 1, pb: 2.5, gap: 1 }}>
        <Button variant="outlined" onClick={onClose} sx={{ minWidth: 76 }}>
          取消
        </Button>
        <Button variant="contained" disabled={!title.trim()} onClick={onSave} sx={{ minWidth: 76 }}>
          保存
        </Button>
      </DialogActions>
    </Dialog>
  )
}
