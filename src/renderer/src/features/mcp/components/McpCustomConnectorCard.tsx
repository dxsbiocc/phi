import { useUiLanguage } from '../../../lib/i18n'
import { connectorCopy } from '../lib/connectorCopy'
import { Button, Chip, Stack, Typography } from '@mui/material'
import type { CustomConnectorEntry } from '../lib/customConnectorGroup'
import { ConnectorIcon } from './ConnectorIcon'
import { ConnectorAddedMark, ConnectorCatalogCardFrame } from './ConnectorCatalogCardFrame'

export function McpCustomConnectorEmptyState(): React.JSX.Element {
  useUiLanguage()

  return (
    <Typography color="text.secondary" sx={{ mt: 2 }}>
      {connectorCopy.customEmpty}
    </Typography>
  )
}

export function McpCustomConnectorCard({
  entry,
  busy,
  onOpen,
  onViewJob
}: {
  entry: CustomConnectorEntry
  busy: boolean
  onOpen: () => void
  onViewJob: (jobId: string) => void
}): React.JSX.Element {
  useUiLanguage()

  const isServer = entry.kind === 'server'
  const statusColor =
    entry.status === connectorCopy.addFailed
      ? 'error'
      : entry.status === connectorCopy.needsSetup
        ? 'warning'
        : 'default'

  return (
    <ConnectorCatalogCardFrame
      icon={<ConnectorIcon />}
      title={entry.name}
      description={entry.subtitle}
      onOpen={isServer ? onOpen : undefined}
      configured={isServer}
      trailing={
        isServer && entry.enabled ? (
          <ConnectorAddedMark label={connectorCopy.addedNamed(entry.name)} />
        ) : entry.kind === 'job' ? (
          <Button
            size="small"
            variant="outlined"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              onViewJob(entry.job.id)
            }}
            sx={{ flexShrink: 0, borderRadius: 1.5 }}
          >
            {connectorCopy.viewProgress}
          </Button>
        ) : null
      }
    >
      <Stack
        direction="row"
        spacing={0.75}
        sx={{
          mt: 0.75,
          minWidth: 0,
          minHeight: 24,
          alignItems: 'center',
          '& .MuiChip-root': { minWidth: 0, flexShrink: 0 }
        }}
      >
        <Typography noWrap title={entry.origin} variant="caption" color="text.secondary">
          {entry.origin}
        </Typography>
        <Chip size="small" variant="outlined" color={statusColor} label={entry.status} />
      </Stack>
    </ConnectorCatalogCardFrame>
  )
}
