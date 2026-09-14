import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'

import { PhiIcons } from '../../../icons'
import type { PendingKernelSwitch } from '../lib/notebookCanvasTypes'

const NotebookIcon = PhiIcons.file.jupyter

export default function NotebookKernelSwitchDialog({
  pending,
  onCancel,
  onConfirm
}: {
  pending: PendingKernelSwitch | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog
      open={Boolean(pending)}
      onClose={onCancel}
      maxWidth="xs"
      fullWidth
      data-phi-notebook-kernel-switch-dialog="true"
      slotProps={{
        paper: {
          sx: {
            borderRadius: 3,
            border: 1,
            borderColor: (theme) => alpha(theme.palette.warning.main, 0.28),
            bgcolor: 'background.paper',
            boxShadow: (theme) => `0 18px 60px ${alpha(theme.palette.common.black, 0.34)}`
          }
        }
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2.5,
          pt: 2.25,
          pb: 1.25,
          fontSize: '1rem',
          fontWeight: 800
        }}
      >
        <NotebookIcon sx={{ fontSize: 21, color: 'warning.main' }} />
        切换 notebook kernel
      </DialogTitle>
      <DialogContent sx={{ px: 2.5, pb: 1 }}>
        <Stack spacing={1.25}>
          <Box
            data-phi-notebook-kernel-switch-summary="true"
            sx={{
              display: 'grid',
              gridTemplateColumns: '64px minmax(0, 1fr)',
              gap: 0.75,
              p: 1.25,
              borderRadius: 2,
              bgcolor: (theme) => alpha(theme.palette.text.primary, 0.045)
            }}
          >
            <Typography variant="caption" color="text.secondary">
              当前
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
              {pending?.currentKernelLabel}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              切换到
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
              {pending?.nextKernelLabel}
            </Typography>
          </Box>
          <Typography
            data-phi-notebook-kernel-switch-warning="true"
            variant="body2"
            color="text.secondary"
            sx={{ lineHeight: 1.65 }}
          >
            {pending?.hasCurrentLiveSession
              ? '当前连接的 kernel 会被终止，正在运行的 cell 会停止。'
              : 'Notebook 的 kernel metadata 会更新，并使用新的 kernel 启动会话。'}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2.5, pb: 2, gap: 1 }}>
        <Button onClick={onCancel} sx={{ borderRadius: 999 }}>
          取消
        </Button>
        <Button
          variant="contained"
          color="warning"
          onClick={onConfirm}
          sx={{ borderRadius: 999, px: 2 }}
        >
          切换 kernel
        </Button>
      </DialogActions>
    </Dialog>
  )
}
