import { useState } from 'react'
import { Alert, Box, Button, Chip, Collapse, Paper, Stack, Switch, Typography } from '@mui/material'
import { GoChevronDown, GoChevronUp } from 'react-icons/go'
import type { ModelAvailabilityChange } from '../../../../../shared/modelAvailabilityTypes'
import type { ProviderAuthStatus } from '../../../types'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { settingsUi } from '../lib/settingsUi'
import { providerStatusText } from '../lib/providerStatusText'
import { providerCapabilityLabel } from '../lib/providerCapabilities'
import { providerManagementUi as copy } from '../lib/providerManagementUi'
import { availabilityTarget, type AvailabilityState } from '../lib/modelAvailabilityController'
import { ProviderModelList } from './ProviderModelList'

function ProviderHeader({
  provider,
  state,
  onLogout,
  onChange
}: ProviderCardProps): React.JSX.Element {
  useUiLanguage()
  const enabled = !state.snapshot?.disabledProviders.includes(provider.providerId)
  const target = availabilityTarget({ providerId: provider.providerId })
  const KeyIcon = PhiIcons.entity.apiKey
  const ShieldIcon = PhiIcons.settings.permissions
  const LogoutIcon = PhiIcons.action.logout
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.25}
      sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.35 }}>
            {provider.name}
          </Typography>
          <Typography
            variant="body2"
            sx={{ color: 'text.secondary', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}
          >
            {provider.providerId}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.75 }}>
          {provider.hasApiKey && <Chip size="small" icon={<KeyIcon />} label="API Key" />}
          {provider.hasOAuth && <Chip size="small" icon={<ShieldIcon />} label="OAuth" />}
          <Chip size="small" variant="outlined" label={providerCapabilityLabel(provider)} />
          {provider.statusText && (
            <Chip size="small" label={providerStatusText(provider.statusText)} variant="outlined" />
          )}
        </Stack>
      </Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
        <Chip
          size="small"
          color={enabled ? 'success' : 'default'}
          label={enabled ? settingsUi.configured : copy.disabled}
        />
        <Switch
          checked={enabled}
          disabled={!state.snapshot || state.loading || state.pending.includes(target)}
          slotProps={{ input: { 'aria-label': copy.providerSwitch(provider.name) } }}
          onChange={(_, next) => onChange({ providerId: provider.providerId, enabled: next })}
        />
        <Button
          variant="outlined"
          color="error"
          size="small"
          onClick={() => onLogout(provider.providerId)}
          startIcon={<LogoutIcon />}
          sx={{ minHeight: 34, px: 1.25 }}
        >
          {settingsUi.logOut}
        </Button>
      </Stack>
    </Stack>
  )
}

export interface ProviderCardProps {
  provider: ProviderAuthStatus
  state: AvailabilityState
  onLogout: (providerId: string) => void
  onChange: (change: ModelAvailabilityChange) => void
}

export function ProviderCard(props: ProviderCardProps): React.JSX.Element {
  useUiLanguage()
  const [expanded, setExpanded] = useState(false)
  const { provider, state, onChange } = props
  const models =
    state.snapshot?.models.filter((model) => model.providerId === provider.providerId) ?? []
  const enabled = !state.snapshot?.disabledProviders.includes(provider.providerId)
  const error = state.errors[availabilityTarget({ providerId: provider.providerId })]
  const decision =
    provider.modelKinds?.includes('decision') || models.some((model) => model.kind === 'decision')
  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 1.25, borderRadius: 1 }}>
      <ProviderHeader {...props} />
      {!enabled && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {copy.disabledHelp}
        </Typography>
      )}
      {decision && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {copy.decisionHelp}
        </Typography>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {copy.saveFailed}: {error}
        </Alert>
      )}
      <Button
        size="small"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        endIcon={expanded ? <GoChevronUp /> : <GoChevronDown />}
        sx={{ mt: 0.75 }}
      >
        {copy.models(models.length)}
      </Button>
      <Collapse in={expanded} unmountOnExit>
        <ProviderModelList
          models={models}
          state={state}
          providerEnabled={enabled}
          onChange={onChange}
        />
      </Collapse>
    </Paper>
  )
}
