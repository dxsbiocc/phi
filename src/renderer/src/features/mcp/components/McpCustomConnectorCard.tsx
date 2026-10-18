import { useUiLanguage } from '../../../lib/i18n'
import { connectorCopy } from '../lib/connectorCopy'
import { Box, Button, Chip, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons } from '../../../icons'
import type { CustomConnectorEntry } from '../lib/customConnectorGroup'

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
  return (
    <Box
      role={isServer ? 'button' : undefined}
      tabIndex={isServer ? 0 : undefined}
      onKeyDown={(event) => {
        if (
          isServer &&
          event.target === event.currentTarget &&
          (event.key === 'Enter' || event.key === ' ')
        ) {
          event.preventDefault()
          onOpen()
        }
      }}
      onClick={isServer ? onOpen : undefined}
      data-phi-connector-configured={isServer || undefined}
      sx={{
        minWidth: 0,
        minHeight: 108,
        p: 1.75,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        cursor: isServer ? 'pointer' : 'default',
        '&:hover': isServer ? { bgcolor: 'action.hover' } : undefined
      }}
    >
      <Box
        sx={{
          width: 40,
          height: 40,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 1.5,
          color: 'primary.main',
          bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1)
        }}
      >
        <PhiIcons.entity.mcp size={22} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap title={entry.name} sx={{ fontWeight: 700 }}>
          {entry.name}
        </Typography>
        <Typography
          noWrap
          title={entry.subtitle}
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.25 }}
        >
          {entry.subtitle}
        </Typography>
        <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, minHeight: 24 }}>
          <Chip size="small" variant="outlined" label={entry.origin} />
          <Chip
            size="small"
            variant="outlined"
            color={
              entry.status === connectorCopy.addFailed
                ? 'error'
                : entry.status === connectorCopy.needsSetup
                  ? 'warning'
                  : 'default'
            }
            label={entry.status}
          />
        </Stack>
      </Box>
      {isServer && entry.enabled ? (
        <Box
          role="img"
          aria-label={connectorCopy.addedNamed(entry.name)}
          data-phi-connector-state="added"
          sx={{
            width: 34,
            height: 34,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            borderRadius: 1.5,
            color: 'success.dark',
            bgcolor: (theme) =>
              alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.28 : 0.16)
          }}
        >
          <PhiIcons.action.approve size={20} />
        </Box>
      ) : entry.kind === 'job' ? (
        <Button
          size="small"
          variant="outlined"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            onViewJob(entry.job.id)
          }}
          sx={{ flexShrink: 0 }}
        >
          {connectorCopy.viewProgress}
        </Button>
      ) : null}
    </Box>
  )
}
