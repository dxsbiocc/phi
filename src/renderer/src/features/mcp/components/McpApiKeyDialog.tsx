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
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'

export function McpApiKeyDialog({
  connector,
  value,
  verified,
  installed,
  busy,
  error,
  onChange,
  onClose,
  onSubmit
}: {
  connector: FeaturedMcpConnector | null
  value: string
  verified: boolean
  installed: boolean
  busy: boolean
  error: string | null
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const name = connector?.name ?? ''
  const canUseSavedKey = verified && !installed
  const canSubmit = Boolean(value.trim()) || canUseSavedKey

  return (
    <Dialog open={Boolean(connector)} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{installed ? `更新 ${name} API key` : `添加 ${name}`}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            输入你的 API key。Phi 会先向 {name} 验证，再将密钥加密保存在本机。
          </Typography>
          {connector?.apiKey && (
            <Button
              component="a"
              href={connector.apiKey.obtainUrl}
              target="_blank"
              rel="noreferrer"
              size="small"
              sx={{ alignSelf: 'flex-start', pl: 0 }}
            >
              前往 {name} 获取 API key ↗
            </Button>
          )}
          {connector?.id === 'serpapi' && (
            <Alert severity="info">
              SerpApi 的账户验证接口要求通过 HTTPS 查询参数发送一次密钥。Phi
              不会保存验证地址；服务商或网络代理可能记录请求地址。
            </Alert>
          )}
          <TextField
            autoFocus
            fullWidth
            type="password"
            label="API key"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit && !busy) onSubmit()
            }}
          />
          {canUseSavedKey && !value && (
            <Typography variant="body2" color="text.secondary">
              已有验证过的密钥，可直接添加；输入新密钥则会替换它。
            </Typography>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button variant="contained" disabled={busy || !canSubmit} onClick={onSubmit}>
          {busy
            ? '正在验证…'
            : value.trim()
              ? installed
                ? '验证并更新'
                : '验证并添加'
              : '添加连接器'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
