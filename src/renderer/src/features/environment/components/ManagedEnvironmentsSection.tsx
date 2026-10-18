import { environmentUi } from '../lib/environmentUi'
import { useUiLanguage } from '../../../lib/i18n'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import CardActions from '@mui/material/CardActions'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import type {
  EnvironmentSnapshot,
  ManagedEnvironmentEntry
} from '../../../../../shared/environmentTypes'
import {
  formatBuildEstimate,
  formatEnvironmentSize,
  managedEnvironmentHostResources,
  managedEnvironmentSourceLabel,
  managedEnvironmentStateLabel
} from '../lib/environmentPanel'
import {
  EnvironmentBrandIcon,
  EnvironmentCapabilityChips,
  EnvironmentHostCapabilityChips
} from './EnvironmentBrandIcon'

type ManagedEnvironmentsSectionProps = {
  environments: readonly ManagedEnvironmentEntry[]
  snapshot: EnvironmentSnapshot | null
  loading: boolean
  error: string | null
  busyEnvId: string | null
  onRetry: () => void
  onBuild: (entry: ManagedEnvironmentEntry) => void
  onRebuild: (entry: ManagedEnvironmentEntry) => void
  onRemove: (entry: ManagedEnvironmentEntry) => void
  onClean: () => void
  onOpen: (entry: ManagedEnvironmentEntry) => void
}

function stateColor(
  state: ManagedEnvironmentEntry['state']
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (state === 'building') return 'primary'
  if (state === 'ready') return 'success'
  if (state === 'failed') return 'error'
  if (state === 'drifted') return 'warning'
  return 'default'
}

function environmentTitle(environment: ManagedEnvironmentEntry): string {
  return environment.label?.trim() || environment.ref
}

function EnvironmentCard({
  environment,
  snapshot,
  busy,
  onOpen,
  onBuild,
  onRebuild,
  onRemove
}: {
  environment: ManagedEnvironmentEntry
  snapshot: EnvironmentSnapshot | null
  busy: boolean
  onOpen: () => void
  onBuild: () => void
  onRebuild: () => void
  onRemove: () => void
}): React.JSX.Element {
  useUiLanguage()
  const hostResources = managedEnvironmentHostResources(environment, snapshot)
  const hasHostResources = hostResources.tools.length + hostResources.dependencies.length > 0
  const removable =
    environment.referrers.length === 0 &&
    (environment.state === 'ready' ||
      environment.state === 'failed' ||
      environment.state === 'drifted')
  const canBuild = environment.source !== 'orphaned' && environment.state === 'absent'
  const canRebuild =
    environment.source !== 'orphaned' &&
    (environment.state === 'ready' ||
      environment.state === 'failed' ||
      environment.state === 'drifted')
  const description = environment.error
    ? environment.error
    : environment.source === 'orphaned'
      ? environmentUi.legacyEnvironmentItCanBeSafelyRemovedWhen
      : environment.description || environmentUi.noAdditionalDescriptionForThisEnvironment
  const secondaryMetric =
    environment.state === 'absent'
      ? formatBuildEstimate(environment.estimate)
      : environment.overrideFrom?.length
        ? environmentUi.overridesValue(environment.overrideFrom.join('、'))
        : '\u00A0'

  return (
    <Card
      variant="outlined"
      component="article"
      data-phi-managed-environment-card={environment.ref}
      sx={{
        height: 284,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 2,
        transition: (theme) =>
          theme.transitions.create(['background-color', 'border-color'], {
            duration: theme.transitions.duration.shorter
          }),
        '&:hover, &:focus-within': {
          bgcolor: 'action.hover',
          borderColor: 'primary.light'
        }
      }}
    >
      <CardActionArea
        aria-label={environmentUi.viewValueDetails(environmentTitle(environment))}
        onClick={onOpen}
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'block',
          textAlign: 'left',
          '& .MuiCardActionArea-focusHighlight': { display: 'none' }
        }}
      >
        <CardContent
          sx={{
            p: 2,
            pb: 0.5,
            height: '100%',
            display: 'grid',
            gridTemplateRows: '60px 44px 56px 20px',
            rowGap: 1,
            minHeight: 0,
            '&:last-child': { pb: 0.5 }
          }}
        >
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start', minWidth: 0 }}>
            <EnvironmentBrandIcon environment={environment} size={52} />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
                <Typography
                  variant="h6"
                  noWrap
                  sx={{ minWidth: 0, fontSize: '1.05rem', fontWeight: 700 }}
                >
                  {environmentTitle(environment)}
                </Typography>
                <Chip
                  size="small"
                  color={stateColor(environment.state)}
                  variant="outlined"
                  label={managedEnvironmentStateLabel(environment.state)}
                  sx={{ flexShrink: 0 }}
                />
              </Stack>
              <Typography
                variant="caption"
                color="text.secondary"
                noWrap
                sx={{ display: 'block', mt: 0.5, fontFamily: 'var(--font-mono)' }}
              >
                {environment.ref}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {managedEnvironmentSourceLabel(environment.source)}
              </Typography>
            </Box>
          </Stack>

          <Typography
            variant="body2"
            color={environment.error ? 'error.main' : 'text.secondary'}
            sx={{
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
              overflow: 'hidden'
            }}
          >
            {description}
          </Typography>

          <Box
            data-phi-environment-slot="capabilities"
            sx={{ minHeight: 0, overflow: 'hidden', alignContent: 'start' }}
          >
            {hasHostResources ? (
              <EnvironmentHostCapabilityChips resources={hostResources} />
            ) : (
              <EnvironmentCapabilityChips environment={environment} />
            )}
          </Box>
          <Typography
            data-phi-environment-slot="estimate"
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {secondaryMetric}
          </Typography>
        </CardContent>
      </CardActionArea>

      <CardActions sx={{ px: 2, pb: 1.5, pt: 0.5, height: 56, alignItems: 'flex-end', gap: 1.5 }}>
        <Box data-phi-environment-slot="metrics" sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1.5} sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap>
              {environmentUi.diskUsage} {formatEnvironmentSize(environment.sizeBytes)}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {environment.consumers.length
                ? environmentUi.valueConsumers(environment.consumers.length)
                : environmentUi.noConsumers}
            </Typography>
          </Stack>
        </Box>
        <Box
          data-phi-environment-slot="actions"
          sx={{ minWidth: 142, display: 'flex', justifyContent: 'flex-end' }}
        >
          {canBuild ? (
            <Button size="small" variant="contained" disabled={busy} onClick={onBuild}>
              {environmentUi.reviewEstimateAndBuild}
            </Button>
          ) : null}
          {canRebuild ? (
            <Button
              size="small"
              variant="outlined"
              disabled={busy}
              onClick={onRebuild}
              startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
            >
              {busy ? environmentUi.rebuilding : environmentUi.rebuild}
            </Button>
          ) : null}
          {environment.state === 'building' ? (
            <Button size="small" variant="outlined" disabled>
              {environmentUi.building}
            </Button>
          ) : null}
          {!canBuild && !canRebuild && environment.state !== 'building' && removable ? (
            <Button
              size="small"
              color="error"
              variant="outlined"
              disabled={busy}
              onClick={onRemove}
            >
              {environmentUi.remove}
            </Button>
          ) : null}
        </Box>
      </CardActions>
    </Card>
  )
}

export function ManagedEnvironmentsSection({
  environments,
  snapshot,
  loading,
  error,
  busyEnvId,
  onRetry,
  onBuild,
  onRebuild,
  onRemove,
  onClean,
  onOpen
}: ManagedEnvironmentsSectionProps): React.JSX.Element {
  useUiLanguage()
  const currentEnvironments = environments.filter(
    (environment) => environment.source !== 'orphaned'
  )
  const orphanedEnvironments = environments.filter(
    (environment) => environment.source === 'orphaned'
  )
  const orphanedSizeBytes = orphanedEnvironments.every(
    (environment) => environment.sizeBytes !== undefined
  )
    ? orphanedEnvironments.reduce((total, environment) => total + (environment.sizeBytes ?? 0), 0)
    : undefined

  return (
    <Stack component="section" spacing={1.25} aria-labelledby="managed-environments-title">
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}
      >
        <Box>
          <Typography id="managed-environments-title" variant="h6">
            {environmentUi.environments}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {environmentUi.phiAutomaticallyDetectsJupyterNextflowAndContainerRuntimes}
          </Typography>
        </Box>
        <Button size="small" color="warning" disabled={loading} onClick={onClean}>
          {environmentUi.cleanUpUnreferencedEnvironments2}
        </Button>
      </Stack>

      {error ? (
        <Alert
          severity="error"
          variant="outlined"
          action={<Button onClick={onRetry}>{environmentUi.retry}</Button>}
        >
          {error}
        </Alert>
      ) : null}

      {loading && currentEnvironments.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 5 }}>
          <CircularProgress size={28} />
        </Box>
      ) : currentEnvironments.length === 0 ? (
        <Alert severity="info" variant="outlined">
          {environmentUi.noEnvironmentsToManage}
        </Alert>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
            gap: 1.5
          }}
        >
          {currentEnvironments.map((environment) => (
            <EnvironmentCard
              key={`${environment.ref}:${environment.envId}`}
              environment={environment}
              snapshot={snapshot}
              busy={busyEnvId === environment.envId}
              onBuild={() => onBuild(environment)}
              onRebuild={() => onRebuild(environment)}
              onRemove={() => onRemove(environment)}
              onOpen={() => onOpen(environment)}
            />
          ))}
        </Box>
      )}

      {orphanedEnvironments.length > 0 ? (
        <Alert
          severity="warning"
          variant="outlined"
          action={
            <Button color="warning" disabled={loading} onClick={onClean}>
              {environmentUi.cleanUpLegacyEnvironments}
            </Button>
          }
        >
          {environmentUi.legacyEnvironmentNotice(
            orphanedEnvironments.length,
            orphanedSizeBytes === undefined ? undefined : formatEnvironmentSize(orphanedSizeBytes)
          )}
        </Alert>
      ) : null}
    </Stack>
  )
}
