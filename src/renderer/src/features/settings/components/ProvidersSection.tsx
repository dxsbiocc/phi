import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material'
import { GoPlus, GoSync } from 'react-icons/go'
import { errorMessage } from '../../../../../shared/errorCodes'
import type { ProviderAuthStatus } from '../../../types'
import { LabeledIconButton } from '../../../components/LabeledIconButton'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { settingsUi } from '../lib/settingsUi'
import { providerManagementUi as copy } from '../lib/providerManagementUi'
import { useModelAvailability } from '../hooks/useModelAvailability'
import { ProviderCard } from './ProviderCard'

export function ProvidersToolbar({
  loading = false,
  onRefresh,
  onOpenAddProvider
}: {
  loading?: boolean
  onRefresh: () => void
  onOpenAddProvider: () => void
}): React.JSX.Element {
  useUiLanguage()
  const refreshLabel = loading ? copy.loading : settingsUi.refreshStatus
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
        <Tooltip title={refreshLabel}>
          <span style={{ display: 'inline-flex' }}>
            <IconButton
              aria-label={refreshLabel}
              aria-busy={loading}
              disabled={loading}
              data-phi-providers-refresh-button="true"
              data-phi-providers-refresh-spinning={loading ? 'true' : 'false'}
              onClick={onRefresh}
              sx={{
                width: 40,
                height: 40,
                color: loading ? 'primary.main' : 'text.secondary',
                '&.Mui-disabled': {
                  color: 'primary.main',
                  opacity: 0.88
                },
                '@keyframes phi-providers-refresh-spin': {
                  from: { transform: 'rotate(0deg)' },
                  to: { transform: 'rotate(360deg)' }
                },
                '& svg': {
                  animation: loading ? 'phi-providers-refresh-spin 0.9s linear infinite' : 'none'
                }
              }}
            >
              <GoSync size={19} />
            </IconButton>
          </span>
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
  const [refreshing, setRefreshing] = useState(false)
  const refreshRevision = useRef(0)
  useEffect(
    () => () => {
      refreshRevision.current += 1
    },
    []
  )
  const configured = providers.filter((provider) => provider.configured)
  const AddIcon = PhiIcons.action.add
  const isLoading = refreshing || state.loading
  async function refresh(): Promise<void> {
    const revision = ++refreshRevision.current
    setRefreshError(null)
    setRefreshing(true)
    try {
      await onRefresh()
      await controller.refresh()
    } catch (cause) {
      if (refreshRevision.current === revision) setRefreshError(errorMessage(cause))
    } finally {
      if (refreshRevision.current === revision) setRefreshing(false)
    }
  }
  return (
    <Stack spacing={1.5} sx={{ minWidth: 0, width: '100%' }}>
      <ProvidersToolbar
        loading={isLoading}
        onRefresh={() => void refresh()}
        onOpenAddProvider={onOpenAddProvider}
      />
      {refreshError && (
        <Alert severity="error">
          {copy.authFailed}: {refreshError}
        </Alert>
      )}
      {state.loadError && (
        <Alert
          severity="error"
          action={
            <LabeledIconButton
              label={copy.retry}
              size="small"
              onClick={() => void controller.refresh()}
            >
              <PhiIcons.action.refresh size={16} aria-hidden />
            </LabeledIconButton>
          }
        >
          {copy.loadFailed}: {state.loadError}
        </Alert>
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
