import { useId } from 'react'
import { Button, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material'

import { useUiLanguage } from '../lib/i18n'
import { resourceUi } from '../lib/resourceUi'
import type { ConfirmationOptions } from '../lib/confirmationController'
import { ConfirmationDialog } from './ConfirmationDialog'

export interface ConfirmationPromptProps {
  options: ConfirmationOptions
  onSettle(confirmed: boolean): void
}

/** Shared confirmation surface; copy is supplied by the requesting feature. */
export function ConfirmationPrompt({
  options,
  onSettle
}: ConfirmationPromptProps): React.JSX.Element {
  useUiLanguage()
  const titleId = useId()
  return (
    <ConfirmationDialog
      open
      onClose={() => onSettle(false)}
      data-phi-confirmation-dialog="true"
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>{options.title}</DialogTitle>
      {options.description === undefined ? null : (
        <DialogContent>
          <DialogContentText component="div">{options.description}</DialogContentText>
        </DialogContent>
      )}
      <DialogActions>
        <Button onClick={() => onSettle(false)}>{resourceUi.cancel}</Button>
        <Button
          color={options.destructive ? 'error' : 'primary'}
          variant="contained"
          onClick={() => onSettle(true)}
        >
          {options.confirmLabel}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
