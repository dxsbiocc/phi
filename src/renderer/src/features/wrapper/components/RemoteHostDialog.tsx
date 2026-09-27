import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography
} from '@mui/material'

export interface RemoteHostDraft {
  id: string
  label: string
  hostAlias: string
  hostname: string
  user: string
  port: string
  identityFile: string
  source: 'ssh-config' | 'phi'
}

export function RemoteHostDialog({
  open,
  draft,
  busy,
  error,
  onDraftChange,
  onClose,
  onSave
}: {
  open: boolean
  draft: RemoteHostDraft
  busy: boolean
  error: string | null
  onDraftChange: (draft: RemoteHostDraft) => void
  onClose: () => void
  onSave: () => void
}): React.JSX.Element {
  const legacy = draft.source === 'phi'
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{draft.id ? '编辑服务器' : '添加服务器'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.75 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              label="SSH 别名"
              value={draft.hostAlias}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  hostAlias: event.target.value,
                  label: event.target.value
                })
              }
              slotProps={{ input: { readOnly: Boolean(draft.id) } }}
              autoFocus={!draft.id}
              fullWidth
            />
            {!legacy && (
              <TextField
                label="服务器地址"
                value={draft.hostname}
                onChange={(event) => onDraftChange({ ...draft, hostname: event.target.value })}
                fullWidth
              />
            )}
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              label="用户名"
              value={draft.user}
              onChange={(event) => onDraftChange({ ...draft, user: event.target.value })}
              fullWidth
            />
            <TextField
              label="端口"
              value={draft.port}
              onChange={(event) => onDraftChange({ ...draft, port: event.target.value })}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              fullWidth
            />
          </Stack>
          <TextField
            label="私钥路径"
            value={draft.identityFile}
            onChange={(event) => onDraftChange({ ...draft, identityFile: event.target.value })}
            fullWidth
          />
          <Typography variant="caption" color="text.secondary">
            {legacy
              ? '旧 Phi 档案的连接参数仍保存在 Phi。'
              : '保存到 ~/.ssh/config；留空的认证字段使用 OpenSSH 默认值。'}
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          variant="contained"
          disabled={busy || !draft.hostAlias.trim() || (!legacy && !draft.hostname.trim())}
          onClick={onSave}
        >
          {draft.id ? '保存修改' : '添加服务器'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
