import { projectCopy } from '../lib/projectCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material'

import type { RemoteProjectConnectionState } from '../../../../../shared/projectLocation'

function ConnectingNotice({
  hostAlias,
  message,
  compact
}: {
  hostAlias?: string
  message: string
  compact: boolean
}): React.JSX.Element {
  return (
    <Stack
      role="status"
      aria-live="polite"
      direction="row"
      spacing={1}
      sx={{
        alignSelf: 'flex-start',
        alignItems: 'center',
        maxWidth: '100%',
        mx: compact ? 1 : 2,
        my: compact ? 1 : 1.5,
        px: 1.5,
        py: 0.75,
        borderRadius: 99,
        bgcolor: 'background.paper',
        boxShadow: 1,
        color: 'text.secondary'
      }}
    >
      <CircularProgress size={18} color="inherit" />
      <Typography variant="body2">
        {hostAlias ? `${hostAlias} · ` : ''}
        {message}
      </Typography>
    </Stack>
  )
}

function connectionMessage(
  connection: RemoteProjectConnectionState | undefined,
  connecting: boolean
): string {
  const progress = connection?.startupProgress
  if (!progress) {
    return (
      connection?.message ??
      (connecting ? projectCopy.connectingToServer : projectCopy.connectionNotChecked)
    )
  }
  if (!progress.totalBytes || progress.totalBytes <= 0) {
    return projectCopy.downloadingRemoteRuntimeWithoutTotal(progress.attempt)
  }
  const percent = Math.min(
    100,
    Math.max(0, Math.floor((progress.bytesReceived / progress.totalBytes) * 100))
  )
  return projectCopy.downloadingRemoteRuntime(percent, progress.attempt)
}

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
  const message = connectionMessage(connection, connecting)
  if (connecting)
    return <ConnectingNotice hostAlias={hostAlias} message={message} compact={compact} />
  return (
    <Alert
      severity={blocked ? 'error' : phase === 'offline' ? 'warning' : 'info'}
      variant="outlined"
      sx={{ mx: compact ? 1 : 2, my: compact ? 1 : 1.5, flexShrink: 0 }}
      action={
        <Stack direction={compact ? 'column' : 'row'} spacing={0.5}>
          <Button size="small" onClick={onRetry}>
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
