import { filterProviderModels } from '../lib/providerCapabilities'
import { useState } from 'react'
import { Alert, Box, Button, Chip, Stack, Switch, TextField, Typography } from '@mui/material'
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
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 0.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {model.name}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {model.modelId}
          </Typography>
        </Box>
        <Chip
          size="small"
          variant="outlined"
          label={model.kind === 'decision' ? copy.decision : copy.chat}
        />
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
  const [limit, setLimit] = useState(20)
  const filtered = filterProviderModels(models, query)
  return (
    <Stack spacing={1} sx={{ mt: 1.5, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
      {!providerEnabled && (
        <Typography variant="caption" color="text.secondary">
          {copy.providerOff}
        </Typography>
      )}
      <TextField
        size="small"
        label={copy.search}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setLimit(20)
        }}
      />
      {filtered
        .slice(0, limit)
        .map(
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
      {filtered.length > limit && (
        <Button onClick={() => setLimit((value) => value + 20)}>{copy.more}</Button>
      )}
    </Stack>
  )
}
