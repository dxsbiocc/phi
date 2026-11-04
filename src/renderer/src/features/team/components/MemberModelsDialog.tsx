import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip
} from '@mui/material'
import type { TeamAdminModelInput } from '../../../../../shared/teamPackTypes'

import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { teamCopy } from '../lib/teamCopy'
import { teamErrorText } from '../lib/teamErrors'

const DeleteIcon = PhiIcons.action.delete

// eslint-disable-next-line max-lines-per-function -- each one-way secret stays beside its provider metadata
export function MemberModelsDialogView({
  open,
  memberName,
  models,
  busy,
  errorCode,
  onAdd,
  onRemove,
  onChange,
  onClose,
  onSubmit
}: {
  open: boolean
  memberName: string
  models: TeamAdminModelInput[]
  busy: boolean
  errorCode: string | null
  onAdd: () => void
  onRemove: (index: number) => void
  onChange: (index: number, model: TeamAdminModelInput) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  useUiLanguage()
  const error = teamErrorText(errorCode)
  const providerIds = models.map((model) => model.providerId.trim()).filter(Boolean)
  const hasDuplicateProvider = new Set(providerIds).size !== providerIds.length
  const valid =
    models.every(
      (model) => model.providerId.trim() && model.label.trim() && model.apiKey.length > 0
    ) && !hasDuplicateProvider

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>{teamCopy.memberModelsTitle(memberName)}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="info">{teamCopy.apiKeyOnlyWarning}</Alert>
          {hasDuplicateProvider ? (
            <Alert severity="error">{teamCopy.duplicateProvider}</Alert>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          {models.map((model, index) => (
            <Paper key={index} variant="outlined" sx={{ p: 1.5 }}>
              <Stack spacing={1.25}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField
                    fullWidth
                    label={teamCopy.provider}
                    value={model.providerId}
                    onChange={(event) =>
                      onChange(index, { ...model, providerId: event.target.value })
                    }
                  />
                  <TextField
                    fullWidth
                    label={teamCopy.label}
                    value={model.label}
                    onChange={(event) => onChange(index, { ...model, label: event.target.value })}
                  />
                  <Tooltip title={teamCopy.removeModelKey}>
                    <IconButton
                      aria-label={teamCopy.removeModelKey}
                      color="error"
                      onClick={() => onRemove(index)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField
                    fullWidth
                    type="password"
                    label={teamCopy.apiKey}
                    value={model.apiKey}
                    autoComplete="off"
                    onChange={(event) => onChange(index, { ...model, apiKey: event.target.value })}
                  />
                  <TextField
                    fullWidth
                    label={teamCopy.baseUrlOptional}
                    value={model.baseUrl ?? ''}
                    onChange={(event) => {
                      const baseUrl = event.target.value
                      const next = { ...model }
                      if (baseUrl) next.baseUrl = baseUrl
                      else delete next.baseUrl
                      onChange(index, next)
                    }}
                  />
                </Stack>
              </Stack>
            </Paper>
          ))}
          <Button variant="outlined" onClick={onAdd}>
            {teamCopy.addModelKey}
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{teamCopy.cancel}</Button>
        <Button variant="contained" disabled={busy || !valid} onClick={onSubmit}>
          {teamCopy.save}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
