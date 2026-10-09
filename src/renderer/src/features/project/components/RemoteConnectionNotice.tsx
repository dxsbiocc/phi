import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material'

import type { RemoteProjectConnectionState } from '../../../../../shared/projectLocation'

export function RemoteConnectionNotice({
  hostAlias,
  connection,
  onRetry,
  onOpenRemoteSettings,
  compact = false
}: {
  hostAlias?: string
  connection?: RemoteProjectConnectionState
  onRetry: () => void
  onOpenRemoteSettings?: () => void
  compact?: boolean
}): React.JSX.Element | null {
  const phase = connection?.phase ?? 'unchecked'
  if (phase === 'reachable') return null
  const connecting = phase === 'connecting'
  const blocked =
    phase === 'identity_failed' ||
    phase === 'authentication_failed' ||
    phase === 'permission_failed' ||
    phase === 'configuration_failed'
  const settingsRelevant =
    phase === 'identity_failed' ||
    phase === 'authentication_failed' ||
    phase === 'configuration_failed'
  const showCooldownGuidance = Boolean(connection?.suggestion?.includes('测试连接可立即重试'))
  const message = connection?.message ?? (connecting ? '正在连接服务器' : '连接尚未检查')
  return (
    <Alert
      severity={blocked ? 'error' : phase === 'offline' ? 'warning' : 'info'}
      variant="outlined"
      sx={{ mx: compact ? 1 : 2, my: compact ? 1 : 1.5, flexShrink: 0 }}
      action={
        <Stack direction={compact ? 'column' : 'row'} spacing={0.5}>
          <Button size="small" disabled={connecting} onClick={onRetry}>
            重新连接
          </Button>
          {settingsRelevant && onOpenRemoteSettings ? (
            <Button size="small" onClick={onOpenRemoteSettings}>
              设置 → 远程
            </Button>
          ) : null}
        </Stack>
      }
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        {connecting ? <CircularProgress size={14} /> : null}
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          {hostAlias ? `${hostAlias} · ` : ''}
          {message}
        </Typography>
      </Box>
      {(!compact || showCooldownGuidance) && connection?.suggestion ? (
        <Typography variant="caption" sx={{ display: 'block' }}>
          {connection.suggestion}
        </Typography>
      ) : null}
      {!compact && phase === 'offline' ? (
        <Typography variant="caption" sx={{ display: 'block' }}>
          对话历史和草稿仍可查看；写入或命令结果未知时先在服务器核对。
        </Typography>
      ) : null}
    </Alert>
  )
}
