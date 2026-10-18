import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import { useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material'

const COLLAPSED_TOOL_COUNT = 9

export function McpToolList({
  requiresSignIn,
  signInMessage,
  loading,
  names,
  error,
  onRetry
}: {
  requiresSignIn: boolean
  signInMessage?: string
  loading: boolean
  names: string[] | null
  error: string | null
  onRetry: () => void
}): React.JSX.Element {
  useUiLanguage()

  const [expanded, setExpanded] = useState(false)
  const visibleNames =
    names && !expanded && names.length > COLLAPSED_TOOL_COUNT
      ? names.slice(0, COLLAPSED_TOOL_COUNT)
      : names
  return (
    <>
      <Stack direction="row" sx={{ mb: 1, alignItems: 'center' }}>
        <Typography variant="h6" sx={{ flex: 1, fontWeight: 700 }}>
          {connectorCopy.serverTools}
          {names ? ` · ${names.length}` : ''}
        </Typography>
        {names !== null && (
          <Button size="small" disabled={loading} onClick={onRetry}>
            {connectorCopy.refreshTools}
          </Button>
        )}
      </Stack>
      {requiresSignIn ? (
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          {signInMessage ?? connectorCopy.unverifiedToolsHint}
        </Typography>
      ) : loading ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 4 }}>
          <CircularProgress size={18} />
          <Typography color="text.secondary">{connectorCopy.loadingTools}</Typography>
        </Stack>
      ) : error ? (
        <Alert
          severity="warning"
          action={<Button onClick={onRetry}>{resourceUi.retry}</Button>}
          sx={{ mb: 4 }}
        >
          {connectorCopy.readToolsFailure(error)}
        </Alert>
      ) : (
        <Box sx={{ mb: 4 }}>
          {names === null ? (
            <Typography color="text.secondary">{connectorCopy.toolsUnread}</Typography>
          ) : names.length === 0 ? (
            <Typography color="text.secondary">{connectorCopy.noServerTools}</Typography>
          ) : (
            <>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  columnGap: 1.5,
                  rowGap: 1
                }}
              >
                {visibleNames?.map((name) => (
                  <Chip
                    key={name}
                    label={name}
                    size="small"
                    variant="outlined"
                    sx={{ justifySelf: 'start', maxWidth: '100%' }}
                  />
                ))}
              </Box>
              {names.length > COLLAPSED_TOOL_COUNT && (
                <Button
                  size="small"
                  onClick={() => setExpanded((current) => !current)}
                  sx={{ mt: 1.5, px: 0 }}
                >
                  {expanded ? connectorCopy.collapse : connectorCopy.showAll}
                </Button>
              )}
            </>
          )}
        </Box>
      )}
    </>
  )
}
