import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material'
import { GoPlus, GoSync } from 'react-icons/go'
import { errorMessage } from '../../../../../shared/errorCodes'
import type { ProviderAuthStatus } from '../../../types'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { settingsUi } from '../lib/settingsUi'
import { providerManagementUi as copy } from '../lib/providerManagementUi'
import { useModelAvailability } from '../hooks/useModelAvailability'
import { ProviderCard } from './ProviderCard'

function ProvidersToolbar({
  onRefresh,
  onOpenAddProvider
}: {
  onRefresh: () => void
  onOpenAddProvider: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 1
      }}
    >
      <Typography variant="h5">{settingsUi.providers}</Typography>
      <Stack direction="row" spacing={1}>
        <Tooltip title={settingsUi.refreshStatus}>
          <IconButton
            aria-label={settingsUi.refreshStatus}
            onClick={onRefresh}
            sx={{ width: 40, height: 40, color: 'text.secondary' }}
          >
            <GoSync size={19} />
          </IconButton>
        </Tooltip>
        <Tooltip title={settingsUi.addProvider}>
          <IconButton
            aria-label={settingsUi.addProvider}
            color="primary"
            onClick={onOpenAddProvider}
            sx={{ width: 40, height: 40 }}
          >
            <GoPlus size={28} />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  )
}

interface ProvidersSectionProps {
  providers: ProviderAuthStatus[]
  onRefresh: () => Promise<void>
  onOpenAddProvider: () => void
  onLogout: (providerId: string) => void
}

export function ProvidersSection({
  providers,
  onRefresh,
  onOpenAddProvider,
  onLogout
}: ProvidersSectionProps): React.JSX.Element {
  useUiLanguage()
  const { state, controller } = useModelAvailability(JSON.stringify(providers))
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const refreshRevision = useRef(0)
  useEffect(
    () => () => {
      refreshRevision.current += 1
    },
    []
  )
  const configured = providers.filter((provider) => provider.configured)
  const AddIcon = PhiIcons.action.add
  async function refresh(): Promise<void> {
    const revision = ++refreshRevision.current
    setRefreshError(null)
    try {
      await onRefresh()
      await controller.refresh()
    } catch (cause) {
      if (refreshRevision.current === revision) setRefreshError(errorMessage(cause))
    }
  }
  return (
    <Stack spacing={1.5}>
      <ProvidersToolbar onRefresh={() => void refresh()} onOpenAddProvider={onOpenAddProvider} />
      {refreshError && (
        <Alert severity="error">
          {copy.authFailed}: {refreshError}
        </Alert>
      )}
      {state.loadError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void controller.refresh()}>{copy.retry}</Button>}
        >
          {copy.loadFailed}: {state.loadError}
        </Alert>
      )}
      {state.loading && (
        <Typography variant="body2" color="text.secondary" role="status">
          {copy.loading}
        </Typography>
      )}
      {!configured.length ? (
        <Paper sx={{ p: 3, borderRadius: 1 }}>
          <Alert severity="warning" sx={{ mb: 2 }}>
            {settingsUi.noProvidersConfigured}
          </Alert>
          <Button
            variant="contained"
            onClick={onOpenAddProvider}
            startIcon={<AddIcon />}
            sx={{ minHeight: 44 }}
          >
            {settingsUi.addAProvider}
          </Button>
        </Paper>
      ) : (
        configured.map((provider) => (
          <ProviderCard
            key={provider.providerId}
            provider={provider}
            state={state}
            onLogout={onLogout}
            onChange={(change) => void controller.change(change)}
          />
        ))
      )}
    </Stack>
  )
}
