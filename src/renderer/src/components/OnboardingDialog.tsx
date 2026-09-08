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
  const [description, setDescription] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  const handleComplete = async (): Promise<void> => {
    setIsSaving(true)
    setError('')
    try {
      await onComplete(description)
    } catch {
      setError('生成人设配置失败，请稍后在设置中重试')
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
      <DialogTitle>用一段话描述你希望的助手</DialogTitle>
      <DialogContent>
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary">
            性格、说话风格、回答偏好都可以写在这里，会据此生成一份专属配置。随时可以在「设置」中查看和修改。跳过则使用默认设置。
          </Typography>
        </Box>
        <TextField
          autoFocus
          placeholder="例如：性格严谨但不失幽默，说话简洁口语化，回答问题先给结论再展开，代码要带注释……"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          fullWidth
          multiline
          minRows={8}
          disabled={isSaving}
        />
        {error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleSkip} disabled={isSaving} sx={{ minHeight: 44 }}>
          跳过，使用默认设置
        </Button>
        <Button
          onClick={handleComplete}
          variant="contained"
          disabled={isSaving || !description.trim()}
          startIcon={isSaving ? <CircularProgress size={16} color="inherit" /> : null}
          sx={{ minHeight: 44 }}
        >
          {isSaving ? '生成中…' : '生成并开始'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default OnboardingDialog
