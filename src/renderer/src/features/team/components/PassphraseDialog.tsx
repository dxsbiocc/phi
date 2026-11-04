import { useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography
} from '@mui/material'

import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import { teamErrorText } from '../lib/teamErrors'
import { passphraseStrength, type PassphraseStrength } from '../lib/teamSecurity'

export type PassphraseDialogKind =
  'member-export' | 'member-import' | 'admin-export' | 'admin-import'

function strengthLabel(level: PassphraseStrength['level']): string {
  if (level === 'strong') return teamCopy.strongPassphrase
  if (level === 'fair') return teamCopy.fairPassphrase
  return teamCopy.weakPassphrase
}

function dialogTitle(kind: PassphraseDialogKind): string {
  if (kind === 'admin-import') return teamCopy.importAdminBackupTitle
  if (kind === 'admin-export') return teamCopy.exportAdminBackupTitle
  if (kind === 'member-import') return teamCopy.importBackupTitle
  return teamCopy.exportBackupTitle
}

// eslint-disable-next-line max-lines-per-function -- paired secret fields stay in one controlled view
export function PassphraseDialogView({
  open,
  kind,
  passphrase,
  confirmation,
  busy,
  errorCode,
  onPassphraseChange,
  onConfirmationChange,
  onClose,
  onSubmit
}: {
  open: boolean
  kind: PassphraseDialogKind
  passphrase: string
  confirmation: string
  busy: boolean
  errorCode: string | null
  onPassphraseChange: (value: string) => void
  onConfirmationChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  useUiLanguage()
  const importing = kind.endsWith('import')
  const strength = passphraseStrength(passphrase)
  const matches = passphrase === confirmation
  const canSubmit = strength.level !== 'weak' && matches && !busy
  const error = teamErrorText(errorCode)

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{dialogTitle(kind)}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          {importing ? (
            <Alert severity="warning">
              {kind === 'admin-import'
                ? teamCopy.adminImportWarning
                : teamCopy.importMemberReplacementWarning}
            </Alert>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField
            autoFocus
            type="password"
            label={teamCopy.backupPassphrase}
            value={passphrase}
            onChange={(event) => onPassphraseChange(event.target.value)}
            autoComplete="new-password"
          />
          <TextField
            type="password"
            label={teamCopy.confirmBackupPassphrase}
            value={confirmation}
            onChange={(event) => onConfirmationChange(event.target.value)}
            autoComplete="new-password"
            error={confirmation.length > 0 && !matches}
            helperText={confirmation.length > 0 && !matches ? teamCopy.passphrasesDoNotMatch : ' '}
          />
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              {strengthLabel(strength.level)}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={strength.score}
              color={
                strength.level === 'strong'
                  ? 'success'
                  : strength.level === 'fair'
                    ? 'warning'
                    : 'error'
              }
            />
            <Typography variant="caption" color="text.secondary">
              {teamCopy.passphraseHint}
            </Typography>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{teamCopy.cancel}</Button>
        <Button variant="contained" disabled={!canSubmit} onClick={onSubmit}>
          {importing ? teamCopy.importAction : teamCopy.exportAction}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export function PassphraseDialog({
  open,
  kind,
  busy,
  errorCode,
  onClose,
  onSubmit
}: {
  open: boolean
  kind: PassphraseDialogKind
  busy: boolean
  errorCode: string | null
  onClose: () => void
  onSubmit: (passphrase: string) => void
}): React.JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')

  function close(): void {
    setPassphrase('')
    setConfirmation('')
    onClose()
  }

  return (
    <PassphraseDialogView
      open={open}
      kind={kind}
      passphrase={passphrase}
      confirmation={confirmation}
      busy={busy}
      errorCode={errorCode}
      onPassphraseChange={setPassphrase}
      onConfirmationChange={setConfirmation}
      onClose={close}
      onSubmit={() => {
        const submitted = passphrase
        setPassphrase('')
        setConfirmation('')
        onSubmit(submitted)
      }}
    />
  )
}
