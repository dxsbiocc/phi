import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type { TeamSourcePreview } from '../../../../../shared/teamPackTypes'

import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import { teamErrorText } from '../lib/teamErrors'

export type SourceLocationKind = 'directory' | 'https'

// eslint-disable-next-line max-lines-per-function -- verified preview and editable source fields share one dialog
export function AddTeamSourceDialogView({
  open,
  locationKind,
  locationValue,
  fingerprint,
  preview,
  busy,
  errorCode,
  onLocationKindChange,
  onLocationValueChange,
  onFingerprintChange,
  onPickDirectory,
  onPreview,
  onSave,
  onClose
}: {
  open: boolean
  locationKind: SourceLocationKind
  locationValue: string
  fingerprint: string
  preview: TeamSourcePreview | null
  busy: 'pick' | 'preview' | 'save' | null
  errorCode: string | null
  onLocationKindChange: (kind: SourceLocationKind) => void
  onLocationValueChange: (value: string) => void
  onFingerprintChange: (value: string) => void
  onPickDirectory: () => void
  onPreview: () => void
  onSave: () => void
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  const canPreview = locationValue.trim().length > 0 && fingerprint.trim().length > 0 && !busy
  const canSave = preview !== null && !busy
  const error = teamErrorText(errorCode)

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{teamCopy.addTeam}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <RadioGroup
            row
            value={locationKind}
            onChange={(event) => onLocationKindChange(event.target.value as SourceLocationKind)}
            aria-label={teamCopy.sourceLocation}
          >
            <FormControlLabel value="directory" control={<Radio />} label={teamCopy.folder} />
            <FormControlLabel value="https" control={<Radio />} label={teamCopy.httpsAddress} />
          </RadioGroup>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            <TextField
              fullWidth
              label={locationKind === 'directory' ? teamCopy.folder : teamCopy.httpsAddress}
              value={locationValue}
              onChange={(event) => onLocationValueChange(event.target.value)}
              placeholder={
                locationKind === 'directory'
                  ? '/Volumes/Team/atlas'
                  : 'https://packages.example/atlas'
              }
            />
            {locationKind === 'directory' ? (
              <Button variant="outlined" disabled={busy !== null} onClick={onPickDirectory}>
                {teamCopy.chooseFolder}
              </Button>
            ) : null}
          </Stack>
          <TextField
            fullWidth
            label={teamCopy.teamFingerprint}
            value={fingerprint}
            onChange={(event) => onFingerprintChange(event.target.value)}
            helperText={teamCopy.fingerprintHint}
          />
          {error ? <Alert severity="error">{error}</Alert> : null}
          {preview ? (
            <Alert severity="success">
              <Typography sx={{ fontWeight: 700 }}>{preview.teamName}</Typography>
              <Typography variant="body2">{teamCopy.confirmTeamValue(preview.teamName)}</Typography>
              <Typography
                component="code"
                variant="caption"
                sx={{ display: 'block', mt: 0.5, overflowWrap: 'anywhere' }}
              >
                {preview.publicKeyFingerprint}
              </Typography>
            </Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{teamCopy.cancel}</Button>
        {!preview ? (
          <Button variant="contained" disabled={!canPreview} onClick={onPreview}>
            {teamCopy.verifyTeam}
          </Button>
        ) : (
          <Button variant="contained" disabled={!canSave} onClick={onSave}>
            {teamCopy.saveTeam}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
