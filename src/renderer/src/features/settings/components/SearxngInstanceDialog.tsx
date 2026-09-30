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
      <DialogTitle>{initialEndpoint ? '修改 SearXNG 实例' : '添加 SearXNG 实例'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="实例地址"
            placeholder="http://127.0.0.1:8888"
            value={endpoint}
            disabled={saving}
            onChange={(event) => setEndpoint(event.target.value)}
            helperText="实例需支持 JSON 搜索和 /config"
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {initialEndpoint && (
          <Button color="error" disabled={saving} onClick={() => void submit('')}>
            移除实例
          </Button>
        )}
        <Button disabled={saving} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="contained"
          disabled={saving || !endpoint.trim() || endpoint.trim() === initialEndpoint}
          onClick={() => void submit(endpoint)}
        >
          {saving ? '保存中' : '保存实例'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
