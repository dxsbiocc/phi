import { analysisCopy } from '../lib/analysisUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import {
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'

import { PhiIcons } from '../../../icons'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
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
  useUiLanguage()
  return (
    <ConfirmationDialog
      open={Boolean(pending)}
      onClose={onCancel}
      data-phi-notebook-kernel-switch-dialog="true"
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1
        }}
      >
        <NotebookIcon sx={{ fontSize: 21, color: 'warning.main' }} />
        {analysisCopy.switchNotebookKernel}
      </DialogTitle>
      <DialogContent>
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
              {analysisCopy.current}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
              {pending?.currentKernelLabel}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {analysisCopy.switchTo}
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
              ? analysisCopy.kernelStopWarning
              : analysisCopy.kernelMetadataSession}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{analysisCopy.cancel}</Button>
        <Button variant="contained" color="warning" onClick={onConfirm}>
          {analysisCopy.switchKernel}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
