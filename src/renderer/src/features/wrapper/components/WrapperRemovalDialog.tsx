import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack
} from '@mui/material'

import type { WrapperRemovalPreview } from '../../../../../shared/packageManagerTypes'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { resourceUi } from '../../../lib/resourceUi'
import { wrapperCopy } from '../lib/wrapperCopy'

export interface WrapperRemovalDialogProps {
  target: WrapperRemovalPreview | null
  removing: boolean
  onClose: () => void
  onConfirm: () => void | Promise<unknown>
}

/** Confirms what a wrapper removal touches before any file or enablement state changes. */
export function WrapperRemovalDialog({
  target,
  removing,
  onClose,
  onConfirm
}: WrapperRemovalDialogProps): React.JSX.Element {
  const dependents = target?.dependents.map((dependent) => dependent.name) ?? []
  return (
    <ConfirmationDialog
      open={Boolean(target)}
      onClose={removing ? undefined : onClose}
      data-phi-wrapper-removal-dialog="true"
    >
      <DialogTitle>{target ? wrapperCopy.removePackageTitle(target.name) : ''}</DialogTitle>
      <DialogContent>
        {target ? (
          <Stack spacing={1.5}>
            <DialogContentText>{wrapperCopy.removePackageInstalled(target.name)}</DialogContentText>
            <Alert severity="error">{wrapperCopy.removePackageFilesWarning}</Alert>
            {dependents.length > 0 ? (
              <Alert severity="warning">{wrapperCopy.removePackageDependents(dependents)}</Alert>
            ) : null}
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button disabled={removing} onClick={onClose}>
          {resourceUi.cancel}
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={removing}
          onClick={() => void onConfirm()}
        >
          {removing ? wrapperCopy.removePackageRemoving : wrapperCopy.removePackageConfirm}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
