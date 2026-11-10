import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack
} from '@mui/material'

import type {
  WrapperRemovalDependent,
  WrapperRemovalPreview
} from '../../../../../shared/packageManagerTypes'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { resourceUi } from '../../../lib/resourceUi'
import { wrapperCopy } from '../lib/wrapperCopy'

function dependentsOf(targets: readonly WrapperRemovalPreview[]): WrapperRemovalDependent[] {
  const dependents = new Map<string, WrapperRemovalDependent>()
  for (const target of targets) {
    for (const dependent of target.dependents) {
      if (!dependents.has(dependent.id)) dependents.set(dependent.id, dependent)
    }
  }
  return [...dependents.values()]
}

/** One confirmation for removing every installed tool of a group, not one dialog per tool. */
export function WrapperSuiteRemovalDialog({
  suite,
  targets,
  removing,
  onClose,
  onConfirm
}: {
  suite: string | null
  targets: readonly WrapperRemovalPreview[]
  removing: boolean
  onClose: () => void
  onConfirm: () => void | Promise<unknown>
}): React.JSX.Element {
  const dependents = dependentsOf(targets).map((dependent) => dependent.name)
  return (
    <ConfirmationDialog
      open={Boolean(suite)}
      onClose={removing ? undefined : onClose}
      data-phi-wrapper-suite-removal-dialog="true"
    >
      <DialogTitle>{suite ? wrapperCopy.removeSuiteTitle(suite) : ''}</DialogTitle>
      <DialogContent>
        {suite ? (
          <Stack spacing={1.5}>
            <DialogContentText>
              {wrapperCopy.removeSuiteInstalled(suite, targets.length)}
            </DialogContentText>
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
