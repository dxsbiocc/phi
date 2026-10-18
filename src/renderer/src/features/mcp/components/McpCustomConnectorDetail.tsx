import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
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
  useUiLanguage()

  const { server } = entry
  const location = server.url || entry.subtitle || connectorCopy.commandNotConfigured
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
          {entry.enabled ? resourceUi.disable : resourceUi.enable}
        </Button>
        <Button color="error" variant="outlined" disabled={busy} onClick={onRequestRemove}>
          {resourceUi.remove}
        </Button>
      </Stack>

      {confirmingRemove ? (
        <Alert
          severity="warning"
          sx={{ mt: 2 }}
          action={
            <Stack direction="row" spacing={1}>
              <Button disabled={busy} onClick={onCancelRemove}>
                {resourceUi.cancel}
              </Button>
              <Button color="error" disabled={busy} onClick={onConfirmRemove}>
                {connectorCopy.confirmRemove}
              </Button>
            </Stack>
          }
        >
          {server.userStdio ? connectorCopy.removeLocalConfirm : connectorCopy.removeRemoteConfirm}
        </Alert>
      ) : null}

      <Divider sx={{ my: 4 }} />
      <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>
        {server.url ? connectorCopy.mcpUrl : connectorCopy.command}
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
            {connectorCopy.environmentNames}
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
