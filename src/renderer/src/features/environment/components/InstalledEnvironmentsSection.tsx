import { useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import InputAdornment from '@mui/material/InputAdornment'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'

import { PhiIcons } from '../../../icons'
import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import type {
  ManagedEnvironmentCheckResult,
  ManagedEnvironmentEntry
} from '../../../../../shared/environmentTypes'
import {
  formatBuildEstimate,
  formatEnvironmentSize,
  installedManagedEnvironments,
  managedEnvironmentSourceLabel,
  managedEnvironmentStateLabel,
  unifiedManagedEnvironmentList
} from '../lib/environmentPanel'
import { environmentUi } from '../lib/environmentUi'
import { EnvironmentBrandIcon } from './EnvironmentBrandIcon'

type InstalledFilter = 'all' | 'builtin' | 'extensions' | 'issues'

type InstalledEnvironmentsSectionProps = {
  environments: readonly ManagedEnvironmentEntry[]
  loading: boolean
  busyEnvId: string | null
  checkingEnvId: string | null
  trimmingCache: boolean
  checkResults: Readonly<Record<string, ManagedEnvironmentCheckResult>>
  onBuild: (entry: ManagedEnvironmentEntry) => void
  onCheck: (entry: ManagedEnvironmentEntry) => void
  onRebuild: (entry: ManagedEnvironmentEntry) => void
  onRemove: (entry: ManagedEnvironmentEntry) => void
  onOpen: (entry: ManagedEnvironmentEntry) => void
  onClean: () => void
  onTrimCache: () => void
}

const EXTENSION_SOURCES = new Set<ManagedEnvironmentEntry['source']>([
  'plugin',
  'skill',
  'mcp',
  'project'
])
const MUTABLE_STATES = new Set<ManagedEnvironmentEntry['state']>(['ready', 'failed', 'drifted'])

function stateChipColor(
  state: ManagedEnvironmentEntry['state']
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (state === 'building') return 'primary'
  if (state === 'ready') return 'success'
  if (state === 'failed') return 'error'
  if (state === 'drifted') return 'warning'
  return 'default'
}

function matchesFilter(entry: ManagedEnvironmentEntry, filter: InstalledFilter): boolean {
  if (filter === 'builtin') return entry.source === 'official'
  if (filter === 'extensions') return EXTENSION_SOURCES.has(entry.source)
  if (filter === 'issues') {
    return entry.source === 'orphaned' || entry.state === 'failed' || entry.state === 'drifted'
  }
  return true
}

function matchesQuery(entry: ManagedEnvironmentEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const haystacks = [
    entry.label ?? '',
    entry.ref,
    entry.envId,
    entry.ownerLabel ?? '',
    entry.pluginId ?? '',
    entry.skillId ?? '',
    entry.mcpId ?? '',
    ...entry.consumers.map((item) => item.label || item.name)
  ]
  return haystacks.some((value) => value.toLowerCase().includes(normalized))
}

function sourceBadgeLabel(environment: ManagedEnvironmentEntry): string {
  const base = managedEnvironmentSourceLabel(environment.source)
  return environment.ownerLabel ? `${base} · ${environment.ownerLabel}` : base
}

function InstalledRowInfo({
  environment,
  checkResult
}: {
  environment: ManagedEnvironmentEntry
  checkResult: ManagedEnvironmentCheckResult | undefined
}): React.JSX.Element {
  const title = environment.label?.trim() || environment.ref
  const consumerCount = environment.consumers.length || environment.referrers.length
  return (
    <Stack direction="row" spacing={1.25} sx={{ minWidth: 0, flex: 1, alignItems: 'center' }}>
      <EnvironmentBrandIcon environment={environment} size={36} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack
          direction="row"
          spacing={0.75}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          <Chip
            size="small"
            color={stateChipColor(environment.state)}
            variant="outlined"
            label={managedEnvironmentStateLabel(environment.state)}
          />
          <Chip size="small" variant="outlined" label={sourceBadgeLabel(environment)} />
          {checkResult ? (
            <Chip
              size="small"
              color={checkResult.ok ? 'success' : 'warning'}
              variant="outlined"
              label={
                checkResult.ok ? environmentUi.checkPassedShort : environmentUi.checkIssuesShort
              }
            />
          ) : null}
        </Stack>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            display: 'block',
            mt: 0.4,
            fontFamily: 'var(--font-mono)',
            overflowWrap: 'anywhere'
          }}
        >
          {environment.ref} · {environment.envId}
        </Typography>
        <Stack direction="row" spacing={1.25} useFlexGap sx={{ mt: 0.4, flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary">
            {environment.state === 'absent' && environment.estimate
              ? formatBuildEstimate(environment.estimate)
              : `${environmentUi.diskUsage} ${formatEnvironmentSize(environment.sizeBytes)}`}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {consumerCount > 0
              ? environmentUi.valueConsumers(consumerCount)
              : environmentUi.noConsumers}
          </Typography>
          {environment.updatedAt ? (
            <Typography variant="caption" color="text.secondary">
              {environmentUi.updatedAtLabel}{' '}
              {new Date(environment.updatedAt).toLocaleString(getUiLocale())}
            </Typography>
          ) : null}
        </Stack>
      </Box>
    </Stack>
  )
}

function InstalledRowActions({
  environment,
  busy,
  checking,
  onBuild,
  onCheck,
  onRebuild,
  onRemove,
  onOpen
}: {
  environment: ManagedEnvironmentEntry
  busy: boolean
  checking: boolean
  onBuild: () => void
  onCheck: () => void
  onRebuild: () => void
  onRemove: () => void
  onOpen: () => void
}): React.JSX.Element {
  const isMutable = MUTABLE_STATES.has(environment.state)
  const canBuild = environment.source !== 'orphaned' && environment.state === 'absent'
  const canRebuild = environment.source !== 'orphaned' && isMutable
  return (
    <Stack
      direction="row"
      spacing={0.75}
      useFlexGap
      sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', md: 'flex-end' } }}
    >
      {canBuild ? (
        <Button size="small" variant="contained" disabled={busy} onClick={onBuild}>
          {environmentUi.reviewEstimateAndBuild}
        </Button>
      ) : null}
      {isMutable ? (
        <Button
          size="small"
          variant="outlined"
          disabled={busy || checking}
          onClick={onCheck}
          startIcon={checking ? <CircularProgress size={12} color="inherit" /> : undefined}
        >
          {checking ? environmentUi.checkingEnvironment : environmentUi.checkEnvironment}
        </Button>
      ) : null}
      {canRebuild ? (
        <Button size="small" variant="outlined" disabled={busy || checking} onClick={onRebuild}>
          {environmentUi.rebuild}
        </Button>
      ) : null}
      {environment.source !== 'orphaned' ? (
        <Button size="small" variant="text" disabled={busy} onClick={onOpen}>
          {environmentUi.viewDetailsShort}
        </Button>
      ) : null}
      {isMutable ? (
        <Button
          size="small"
          color="error"
          variant="outlined"
          disabled={busy || checking}
          onClick={onRemove}
          data-phi-installed-environment-delete={environment.envId}
        >
          {environmentUi.deleteEnvironment}
        </Button>
      ) : null}
    </Stack>
  )
}

function InstalledEnvironmentRow({
  environment,
  busy,
  checking,
  checkResult,
  onBuild,
  onCheck,
  onRebuild,
  onRemove,
  onOpen
}: {
  environment: ManagedEnvironmentEntry
  busy: boolean
  checking: boolean
  checkResult: ManagedEnvironmentCheckResult | undefined
  onBuild: () => void
  onCheck: () => void
  onRebuild: () => void
  onRemove: () => void
  onOpen: () => void
}): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      data-phi-installed-environment-row={environment.envId}
      sx={{ p: 1.5, borderRadius: 2 }}
    >
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { xs: 'stretch', md: 'center' }, justifyContent: 'space-between' }}
      >
        <InstalledRowInfo environment={environment} checkResult={checkResult} />
        <InstalledRowActions
          environment={environment}
          busy={busy}
          checking={checking}
          onBuild={onBuild}
          onCheck={onCheck}
          onRebuild={onRebuild}
          onRemove={onRemove}
          onOpen={onOpen}
        />
      </Stack>
      {checkResult && !checkResult.ok && checkResult.problems.length > 0 ? (
        <Alert severity="warning" variant="outlined" sx={{ mt: 1 }}>
          {checkResult.problems.slice(0, 3).join('; ')}
        </Alert>
      ) : null}
    </Paper>
  )
}

function InstalledSectionToolbar({
  installedCount,
  totalBytes,
  loading,
  trimmingCache,
  onClean,
  onTrimCache
}: {
  installedCount: number
  totalBytes: number
  loading: boolean
  trimmingCache: boolean
  onClean: () => void
  onTrimCache: () => void
}): React.JSX.Element {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.5}
      sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between' }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Typography id="installed-environments-title" variant="h6">
            {environmentUi.installedEnvironments}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={environmentUi.installedCountSummary(
              installedCount,
              formatEnvironmentSize(totalBytes)
            )}
          />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {environmentUi.installedEnvironmentsDescription}
        </Typography>
      </Box>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', flexShrink: 0 }}>
        <Button
          size="small"
          variant="outlined"
          disabled={loading || trimmingCache}
          onClick={onTrimCache}
          startIcon={trimmingCache ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {environmentUi.trimCache}
        </Button>
        <Button
          size="small"
          color="warning"
          variant="outlined"
          disabled={loading}
          onClick={onClean}
        >
          {environmentUi.cleanUpUnreferencedEnvironments2}
        </Button>
      </Stack>
    </Stack>
  )
}

function InstalledFilterBar({
  query,
  filter,
  onQueryChange,
  onFilterChange
}: {
  query: string
  filter: InstalledFilter
  onQueryChange: (value: string) => void
  onFilterChange: (value: InstalledFilter) => void
}): React.JSX.Element {
  const filterChips: Array<{ id: InstalledFilter; label: string }> = [
    { id: 'all', label: environmentUi.filterAll },
    { id: 'builtin', label: environmentUi.filterBuiltin },
    { id: 'extensions', label: environmentUi.filterExtensions },
    { id: 'issues', label: environmentUi.filterIssues }
  ]
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}
    >
      <TextField
        size="small"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={environmentUi.searchInstalledEnvironments}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <PhiIcons.action.search size={15} aria-hidden />
              </InputAdornment>
            )
          }
        }}
        sx={{ minWidth: { xs: '100%', sm: 260 } }}
      />
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {filterChips.map((item) => (
          <Chip
            key={item.id}
            size="small"
            clickable
            color={filter === item.id ? 'primary' : 'default'}
            variant={filter === item.id ? 'filled' : 'outlined'}
            label={item.label}
            onClick={() => onFilterChange(item.id)}
          />
        ))}
      </Stack>
    </Stack>
  )
}

export function InstalledEnvironmentsSection({
  environments,
  loading,
  busyEnvId,
  checkingEnvId,
  trimmingCache,
  checkResults,
  onBuild,
  onCheck,
  onRebuild,
  onRemove,
  onOpen,
  onClean,
  onTrimCache
}: InstalledEnvironmentsSectionProps): React.JSX.Element {
  useUiLanguage()
  const [filter, setFilter] = useState<InstalledFilter>('all')
  const [query, setQuery] = useState('')

  const installed = useMemo(() => installedManagedEnvironments(environments), [environments])
  const listItems = useMemo(() => unifiedManagedEnvironmentList(environments), [environments])
  const totalBytes = useMemo(
    () => installed.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    [installed]
  )
  const filtered = useMemo(
    () => listItems.filter((entry) => matchesFilter(entry, filter) && matchesQuery(entry, query)),
    [listItems, filter, query]
  )

  return (
    <Stack
      component="section"
      spacing={1.25}
      aria-labelledby="installed-environments-title"
      data-phi-installed-environments-section=""
    >
      <InstalledSectionToolbar
        installedCount={installed.length}
        totalBytes={totalBytes}
        loading={loading}
        trimmingCache={trimmingCache}
        onClean={onClean}
        onTrimCache={onTrimCache}
      />
      {listItems.length > 0 ? (
        <InstalledFilterBar
          query={query}
          filter={filter}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
        />
      ) : null}
      {listItems.length === 0 ? (
        <Alert severity="info" variant="outlined">
          {environmentUi.noInstalledEnvironments}
        </Alert>
      ) : filtered.length === 0 ? (
        <Alert severity="info" variant="outlined">
          {environmentUi.noEnvironmentsToManage}
        </Alert>
      ) : (
        <Stack spacing={1}>
          {filtered.map((environment) => (
            <InstalledEnvironmentRow
              key={environment.envId}
              environment={environment}
              busy={busyEnvId === environment.envId}
              checking={checkingEnvId === environment.envId}
              checkResult={checkResults[environment.envId]}
              onBuild={() => onBuild(environment)}
              onCheck={() => onCheck(environment)}
              onRebuild={() => onRebuild(environment)}
              onRemove={() => onRemove(environment)}
              onOpen={() => onOpen(environment)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  )
}
