import { filterProviderModels } from '../lib/providerCapabilities'
import { useState } from 'react'
import { Alert, Box, Chip, Stack, Switch, TextField, Typography } from '@mui/material'
import type {
  ManagedProviderModel,
  ModelAvailabilityChange,
  ModelAvailabilitySnapshot
} from '../../../../../shared/modelAvailabilityTypes'
import { useUiLanguage } from '../../../lib/i18n'
import { availabilityTarget, type AvailabilityState } from '../lib/modelAvailabilityController'
import { providerManagementUi as copy } from '../lib/providerManagementUi'

function ModelRow({
  model,
  snapshot,
  state,
  providerEnabled,
  onChange
}: {
  model: ManagedProviderModel
  snapshot: ModelAvailabilitySnapshot
  state: AvailabilityState
  providerEnabled: boolean
  onChange: (change: ModelAvailabilityChange) => void
}): React.JSX.Element {
  useUiLanguage()
  const target = availabilityTarget(model)
  const checked = !snapshot.disabledModels.some((item) => availabilityTarget(item) === target)
  const label = model.name.trim() || model.modelId
  return (
    <Box role="listitem">
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', minHeight: 32, minWidth: 0, py: 0.25, width: '100%' }}
      >
        <Typography
          variant="body2"
          noWrap
          title={label === model.modelId ? label : model.modelId}
          sx={{ flex: 1, minWidth: 0 }}
        >
          {label}
        </Typography>
        {model.kind === 'decision' && (
          <Chip size="small" variant="outlined" label={copy.decision} />
        )}
        <Switch
          size="small"
          checked={checked}
          disabled={!providerEnabled || !model.configured || state.pending.includes(target)}
          slotProps={{ input: { 'aria-label': copy.modelSwitch(model.name) } }}
          onChange={(_, enabled) =>
            onChange({ providerId: model.providerId, modelId: model.modelId, enabled })
          }
        />
      </Stack>
      {state.errors[target] && (
        <Alert severity="error">
          {copy.saveFailed}: {state.errors[target]}
        </Alert>
      )}
    </Box>
  )
}

export function ProviderModelList({
  models,
  state,
  providerEnabled,
  onChange
}: {
  models: ManagedProviderModel[]
  state: AvailabilityState
  providerEnabled: boolean
  onChange: (change: ModelAvailabilityChange) => void
}): React.JSX.Element {
  useUiLanguage()
  const [query, setQuery] = useState('')
  const filtered = filterProviderModels(models, query)
  return (
    <Stack
      spacing={1}
      sx={{ mt: 1.5, pt: 1.5, borderTop: 1, borderColor: 'divider', minWidth: 0, width: '100%' }}
    >
      {!providerEnabled && (
        <Typography variant="caption" color="text.secondary">
          {copy.providerOff}
        </Typography>
      )}
      <TextField
        fullWidth
        size="small"
        label={copy.search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        sx={{ minWidth: 0 }}
      />
      <Box
        role="list"
        aria-label={copy.models(filtered.length)}
        sx={{
          maxHeight: 280,
          minWidth: 0,
          overflowX: 'hidden',
          overflowY: 'auto',
          scrollbarGutter: 'stable',
          width: '100%'
        }}
      >
        {filtered.map(
          (model) =>
            state.snapshot && (
              <ModelRow
                key={availabilityTarget(model)}
                model={model}
                snapshot={state.snapshot}
                state={state}
                providerEnabled={providerEnabled}
                onChange={onChange}
              />
            )
        )}
        {!filtered.length && (
          <Typography variant="body2" color="text.secondary">
            {models.length ? copy.noMatches : copy.noModels}
          </Typography>
        )}
      </Box>
    </Stack>
  )
}
