import { useState } from 'react'
import { Alert, Box, Button, Chip, Collapse, Paper, Stack, Switch, Typography } from '@mui/material'
import { GoChevronDown, GoChevronUp } from 'react-icons/go'
import type { ModelAvailabilityChange } from '../../../../../shared/modelAvailabilityTypes'
import type { ProviderAuthStatus } from '../../../types'
import { ProviderModelIcon } from '../../../components/chat/ProviderModelIcon'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import { settingsUi } from '../lib/settingsUi'
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
  const decision = provider.modelKinds?.includes('decision')
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.25}
      sx={{ alignItems: { xs: 'stretch', sm: 'center' }, minWidth: 0, width: '100%' }}
    >
      <Box aria-hidden sx={{ display: 'inline-flex', flexShrink: 0 }}>
        <ProviderModelIcon providerId={provider.providerId} disabled={!enabled} size={32} />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="subtitle1" noWrap sx={{ fontWeight: 700, lineHeight: 1.35 }}>
          {provider.name}
        </Typography>
        <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.75 }}>
          <Chip
            size="small"
            color={enabled ? 'success' : 'default'}
            label={enabled ? settingsUi.configured : copy.disabled}
          />
          {provider.hasApiKey && <Chip size="small" icon={<KeyIcon />} label="API Key" />}
          {provider.hasOAuth && <Chip size="small" icon={<ShieldIcon />} label="OAuth" />}
          {decision && <Chip size="small" variant="outlined" label={copy.decision} />}
        </Stack>
      </Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
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
  return (
    <Paper
      variant="outlined"
      sx={{ px: 1.5, py: 1.25, borderRadius: 1, width: '100%', minWidth: 0, overflow: 'hidden' }}
    >
      <ProviderHeader {...props} />
      {!enabled && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {copy.disabledHelp}
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
      <Collapse in={expanded} unmountOnExit sx={{ minWidth: 0, width: '100%' }}>
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
