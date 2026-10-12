import { Alert, Box, Button, Chip, Divider, Stack, Typography } from '@mui/material'
import type { CustomConnectorServerEntry } from '../lib/customConnectorGroup'
import { ConnectorIcon } from './ConnectorIcon'

export function McpCustomConnectorDetail({
  entry,
  busy,
  error,
  confirmingRemove,
  onEnabledChange,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove
}: {
  entry: CustomConnectorServerEntry
  busy: boolean
  error: string | null
  confirmingRemove: boolean
  onEnabledChange: (enabled: boolean) => void
  onRequestRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
}): React.JSX.Element {
  const { server } = entry
  const location = server.url || entry.subtitle || '未配置命令'
  return (
    <Box sx={{ width: '100%', maxWidth: 760, mx: 'auto' }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
        <ConnectorIcon icon={server.icon} size={64} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
            {entry.name}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap' }}>
            <Chip size="small" color="primary" variant="outlined" label={entry.origin} />
            <Chip size="small" variant="outlined" label={entry.status} />
          </Stack>
        </Box>
        <Button variant="outlined" disabled={busy} onClick={() => onEnabledChange(!entry.enabled)}>
          {entry.enabled ? '停用' : '启用'}
        </Button>
        <Button color="error" variant="outlined" disabled={busy} onClick={onRequestRemove}>
          移除
        </Button>
      </Stack>

      {confirmingRemove ? (
        <Alert
          severity="warning"
          sx={{ mt: 2 }}
          action={
            <Stack direction="row" spacing={1}>
              <Button disabled={busy} onClick={onCancelRemove}>
                取消
              </Button>
              <Button color="error" disabled={busy} onClick={onConfirmRemove}>
                确认移除
              </Button>
            </Stack>
          }
        >
          {server.userStdio ? '确认移除这个本地 stdio 连接器？' : '确认移除这个远程 HTTPS 连接器？'}
        </Alert>
      ) : null}

      <Divider sx={{ my: 4 }} />
      <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>
        {server.url ? 'MCP 地址' : '命令'}
      </Typography>
      <Typography
        component="code"
        sx={{ display: 'block', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}
      >
        {location}
      </Typography>

      {server.envKeys?.length ? (
        <>
          <Typography variant="h6" sx={{ mt: 4, mb: 1, fontWeight: 700 }}>
            环境变量名称
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            {server.envKeys.map((key) => (
              <Chip key={key} size="small" variant="outlined" label={key} />
            ))}
          </Stack>
        </>
      ) : null}

      {error ? (
        <Alert severity="error" sx={{ mt: 3 }}>
          {error}
        </Alert>
      ) : null}
    </Box>
  )
}
