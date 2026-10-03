import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import type { EnvironmentBuildEstimate } from '../../../shared/environmentBuildTypes'
import { formatBuildEstimate } from '../lib/environmentFormatting'

export type EnvironmentBuildConfirmTarget = {
  ref: string
  label?: string
  estimate?: EnvironmentBuildEstimate
}

export function EnvironmentBuildConfirmDialog({
  environment,
  working,
  onClose,
  onConfirm
}: {
  environment: EnvironmentBuildConfirmTarget | null
  working: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog
      open={environment !== null}
      onClose={working ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      disablePortal
    >
      <DialogTitle>
        {environment ? `构建 ${environment.label ?? environment.ref}？` : ''}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          <DialogContentText>
            {formatBuildEstimate(environment?.estimate)}
            。确认后会在后台构建，进度可在后台任务面板查看。
          </DialogContentText>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}
          >
            {environment?.ref}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button disabled={working} onClick={onClose}>
          取消
        </Button>
        <Button
          color="primary"
          variant="contained"
          disabled={working}
          onClick={onConfirm}
          startIcon={working ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {working ? '处理中…' : '开始构建'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
