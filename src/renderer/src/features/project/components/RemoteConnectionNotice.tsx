import { projectCopy } from '../lib/projectCopy'
import { useUiLanguage } from '../../../lib/i18n'
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
  useUiLanguage()
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
  const message =
    connection?.message ??
    (connecting ? projectCopy.connectingToServer : projectCopy.connectionNotChecked)
  return (
    <Alert
      severity={blocked ? 'error' : phase === 'offline' ? 'warning' : 'info'}
      variant="outlined"
      sx={{ mx: compact ? 1 : 2, my: compact ? 1 : 1.5, flexShrink: 0 }}
      action={
        <Stack direction={compact ? 'column' : 'row'} spacing={0.5}>
          <Button size="small" disabled={connecting} onClick={onRetry}>
            {projectCopy.reconnect}
          </Button>
          {settingsRelevant && onOpenRemoteSettings ? (
            <Button size="small" onClick={onOpenRemoteSettings}>
              {projectCopy.settingsRemote}
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
          {projectCopy.historyAndDraftsRemainAvailableVerifyUncertainFileChangesOr}
        </Typography>
      ) : null}
    </Alert>
  )
}
