import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import { ConfirmationDialog } from './ConfirmationDialog'
import type { EnvironmentBuildEstimate } from '../../../shared/environmentBuildTypes'
import { formatBuildEstimate } from '../lib/environmentFormatting'
import { useUiLanguage } from '../lib/i18n'
import { resourceEnvironmentCopy, resourceUi } from '../lib/resourceUi'

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
  const language = useUiLanguage()
  return (
    <ConfirmationDialog
      open={environment !== null}
      onClose={working ? undefined : onClose}
      disablePortal
    >
      <DialogTitle>
        {environment
          ? resourceEnvironmentCopy.confirmTitle(environment.label ?? environment.ref)
          : ''}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          <DialogContentText>
            {formatBuildEstimate(environment?.estimate, language)}
            {language === 'en' ? '. ' : '。'}
            {resourceEnvironmentCopy.confirmDescription}
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
      <DialogActions>
        <Button disabled={working} onClick={onClose}>
          {resourceUi.cancel}
        </Button>
        <Button
          color="primary"
          variant="contained"
          disabled={working}
          onClick={onConfirm}
          startIcon={working ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {working ? resourceEnvironmentCopy.working : resourceEnvironmentCopy.startBuild}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
