import { settingsUi } from '../features/settings/lib/settingsUi'
import { useUiLanguage } from '../lib/i18n'
import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography
} from '@mui/material'

type OnboardingDialogProps = {
  open: boolean
  onComplete: (description: string) => Promise<void>
  onSkip: () => Promise<void>
}

function OnboardingDialog({ open, onComplete, onSkip }: OnboardingDialogProps): React.JSX.Element {
  useUiLanguage()
  const [description, setDescription] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [hasError, setHasError] = useState(false)

  const handleComplete = async (): Promise<void> => {
    setIsSaving(true)
    setHasError(false)
    try {
      await onComplete(description)
    } catch {
      setHasError(true)
    } finally {
      setIsSaving(false)
    }
  }

  const handleSkip = async (): Promise<void> => {
    setIsSaving(true)
    try {
      await onSkip()
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} maxWidth="sm" fullWidth>
      <DialogTitle>{settingsUi.describeYourIdealAssistant}</DialogTitle>
      <DialogContent>
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary">
            {settingsUi.describeItsPersonalityToneAndResponsePreferencesTo}
          </Typography>
        </Box>
        <TextField
          autoFocus
          placeholder={settingsUi.forExamplePreciseWithASenseOfHumor}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          fullWidth
          multiline
          minRows={8}
          disabled={isSaving}
        />
        {hasError ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {settingsUi.unableToGenerateAssistantPreferencesTryAgainLater}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleSkip} disabled={isSaving} sx={{ minHeight: 44 }}>
          {settingsUi.skipAndUseDefaults}
        </Button>
        <Button
          onClick={handleComplete}
          variant="contained"
          disabled={isSaving || !description.trim()}
          startIcon={isSaving ? <CircularProgress size={16} color="inherit" /> : null}
          sx={{ minHeight: 44 }}
        >
          {isSaving ? settingsUi.generating : settingsUi.generateAndStart}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default OnboardingDialog
