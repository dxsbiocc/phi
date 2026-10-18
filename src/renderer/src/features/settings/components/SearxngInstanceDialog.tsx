import { settingsUi } from '../lib/settingsUi'
import { useUiLanguage } from '../../../lib/i18n'
import { useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField
} from '@mui/material'

export function SearxngInstanceDialog({
  initialEndpoint,
  onClose,
  onSave
}: {
  initialEndpoint: string
  onClose: () => void
  onSave: (endpoint: string) => Promise<void>
}): React.JSX.Element {
  useUiLanguage()
  const [endpoint, setEndpoint] = useState(initialEndpoint)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(value: string): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await onSave(value)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {initialEndpoint ? settingsUi.editSearXNGInstance : settingsUi.addSearXNGInstance}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label={settingsUi.instanceURL}
            placeholder="http://127.0.0.1:8888"
            value={endpoint}
            disabled={saving}
            onChange={(event) => setEndpoint(event.target.value)}
            helperText={settingsUi.theInstanceMustSupportJSONSearchAndConfig}
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {initialEndpoint && (
          <Button color="error" disabled={saving} onClick={() => void submit('')}>
            {settingsUi.removeInstance}
          </Button>
        )}
        <Button disabled={saving} onClick={onClose}>
          {settingsUi.cancel}
        </Button>
        <Button
          variant="contained"
          disabled={saving || !endpoint.trim() || endpoint.trim() === initialEndpoint}
          onClick={() => void submit(endpoint)}
        >
          {saving ? settingsUi.saving : settingsUi.saveInstance}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
