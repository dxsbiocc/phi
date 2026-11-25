import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import { useState } from 'react'
import { Alert, Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { PhiIcons } from '../../../icons'
import { LabeledIconButton } from '../../../components/LabeledIconButton'
import { mcpToolFailureText } from '../../../../../shared/mcpToolFailureText'

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
  const showRefreshButton = !requiresSignIn && (names !== null || loading)
  const refreshLabel = loading ? connectorCopy.loadingTools : connectorCopy.refreshTools

  return (
    <>
      <Stack direction="row" sx={{ mb: 1, alignItems: 'center', minHeight: 32 }}>
        <Typography variant="h6" sx={{ flex: 1, fontWeight: 700 }}>
          {connectorCopy.serverTools}
          {names ? ` · ${names.length}` : ''}
        </Typography>
        {showRefreshButton && (
          <Tooltip title={refreshLabel}>
            <span style={{ display: 'inline-flex', flexShrink: 0 }}>
              <IconButton
                type="button"
                size="small"
                aria-label={refreshLabel}
                aria-busy={loading}
                disabled={loading}
                data-phi-mcp-tools-refresh-button="true"
                data-phi-mcp-tools-refresh-spinning={loading ? 'true' : 'false'}
                onClick={onRetry}
                sx={{
                  width: 30,
                  height: 30,
                  p: 0,
                  borderRadius: '50%',
                  color: loading ? 'primary.main' : 'text.secondary',
                  '&.Mui-disabled': {
                    color: loading ? 'primary.main' : 'action.disabled',
                    opacity: loading ? 0.88 : 1
                  },
                  '@keyframes phi-mcp-tools-refresh-spin': {
                    from: { transform: 'rotate(0deg)' },
                    to: { transform: 'rotate(360deg)' }
                  },
                  '& svg': {
                    animation: loading ? 'phi-mcp-tools-refresh-spin 0.9s linear infinite' : 'none'
                  }
                }}
              >
                <PhiIcons.action.refresh size={16} />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>
      {requiresSignIn ? (
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          {signInMessage ?? connectorCopy.unverifiedToolsHint}
        </Typography>
      ) : error && !loading ? (
        <Alert
          severity="warning"
          action={
            <LabeledIconButton label={resourceUi.retry} size="small" onClick={onRetry}>
              <PhiIcons.action.refresh size={16} aria-hidden />
            </LabeledIconButton>
          }
          sx={{ mb: 4 }}
        >
          {connectorCopy.readToolsFailure(mcpToolFailureText(error))}
        </Alert>
      ) : (
        <Box sx={{ mb: 4 }}>
          {names === null ? (
            loading ? (
              <Box sx={{ minHeight: 24 }} />
            ) : (
              <Typography color="text.secondary">{connectorCopy.toolsUnread}</Typography>
            )
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
