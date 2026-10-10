import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography
} from '@mui/material'

export type RemoteHostAuthMode = 'passwordless' | 'existing-key'

export interface RemoteHostDraft {
  id: string
  label: string
  hostAlias: string
  hostname: string
  user: string
  port: string
  identityFile: string
  source: 'ssh-config' | 'phi'
  authMode?: RemoteHostAuthMode
}

function AuthenticationOption({
  value,
  selected,
  title,
  description,
  disabled
}: {
  value: RemoteHostAuthMode
  selected: boolean
  title: string
  description: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <FormControlLabel
      value={value}
      disabled={disabled}
      control={<Radio />}
      label={
        <Box sx={{ py: 0.25 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
            {description}
          </Typography>
        </Box>
      }
      sx={{
        m: 0,
        px: 1.25,
        py: 0.75,
        minHeight: 72,
        alignItems: 'flex-start',
        border: 1,
        borderColor: selected ? 'primary.main' : 'divider',
        borderRadius: 2,
        bgcolor: selected ? 'action.selected' : 'background.paper',
        transition: 'border-color 180ms ease, background-color 180ms ease',
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
        '& .MuiRadio-root': { mt: -0.25 },
        '& .MuiFormControlLabel-label': { flex: 1 }
      }}
    />
  )
}

export function RemoteHostDialog({
  open,
  draft,
  busy,
  error,
  onDraftChange,
  onClose,
  onSave,
  onPasswordBootstrap
}: {
  open: boolean
  draft: RemoteHostDraft
  busy: boolean
  error: string | null
  onDraftChange: (draft: RemoteHostDraft) => void
  onClose: () => void
  onSave: () => void
  onPasswordBootstrap?: () => void
}): React.JSX.Element {
  const legacy = draft.source === 'phi'
  const authMode: RemoteHostAuthMode =
    legacy || !onPasswordBootstrap ? 'existing-key' : (draft.authMode ?? 'passwordless')
  const configuringPasswordless = !legacy && authMode === 'passwordless' && onPasswordBootstrap
  const connectionReady = Boolean(draft.hostAlias.trim() && (legacy || draft.hostname.trim()))
  const passwordlessReady = connectionReady && Boolean(draft.user.trim())

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { borderRadius: 3 } } }}
    >
      <DialogTitle component="div" sx={{ px: 3, pt: 3, pb: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 750 }}>
          {draft.id ? '编辑服务器' : '添加服务器'}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
          连接信息会写入 OpenSSH 配置，Phi 不保存服务器密码。
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ px: 3, pb: 3 }}>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <Stack spacing={1.5}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              连接信息
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                label="SSH 别名"
                placeholder="例如：lab-gpu"
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
                  placeholder="域名或 IP 地址"
                  value={draft.hostname}
                  onChange={(event) => onDraftChange({ ...draft, hostname: event.target.value })}
                  fullWidth
                />
              )}
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                label="用户名"
                placeholder="例如：ubuntu"
                value={draft.user}
                onChange={(event) => onDraftChange({ ...draft, user: event.target.value })}
                fullWidth
              />
              <TextField
                label="端口"
                placeholder="22"
                value={draft.port}
                onChange={(event) => onDraftChange({ ...draft, port: event.target.value })}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                sx={{ width: { xs: '100%', sm: 160 }, flexShrink: 0 }}
              />
            </Stack>
          </Stack>

          {!legacy && (
            <FormControl>
              <FormLabel id="remote-host-authentication-label" sx={{ mb: 1, fontWeight: 700 }}>
                认证方式
              </FormLabel>
              <RadioGroup
                aria-labelledby="remote-host-authentication-label"
                value={authMode}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    authMode: event.target.value as RemoteHostAuthMode
                  })
                }
                sx={{ gap: 1 }}
              >
                <AuthenticationOption
                  value="passwordless"
                  selected={authMode === 'passwordless'}
                  title="免密登录（推荐）"
                  description="先验证一次服务器密码，再生成 Phi 专用密钥并写入 ~/.ssh/config。"
                  disabled={!onPasswordBootstrap}
                />
                <AuthenticationOption
                  value="existing-key"
                  selected={authMode === 'existing-key'}
                  title="使用现有 SSH 配置"
                  description="沿用 ssh-agent、OpenSSH 默认密钥，或已配置的 IdentityFile。"
                />
              </RadioGroup>
            </FormControl>
          )}

          {authMode === 'existing-key' && (
            <TextField
              label="私钥路径（可选）"
              placeholder="~/.ssh/id_ed25519"
              value={draft.identityFile}
              helperText={
                legacy ? '旧 Phi 档案的连接参数仍保存在 Phi。' : '留空时使用 OpenSSH 默认认证。'
              }
              onChange={(event) => onDraftChange({ ...draft, identityFile: event.target.value })}
              fullWidth
            />
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2.25, borderTop: 1, borderColor: 'divider' }}>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          variant="contained"
          disabled={busy || (configuringPasswordless ? !passwordlessReady : !connectionReady)}
          onClick={configuringPasswordless ? onPasswordBootstrap : onSave}
        >
          {configuringPasswordless ? '继续设置免密登录' : draft.id ? '保存修改' : '添加服务器'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
