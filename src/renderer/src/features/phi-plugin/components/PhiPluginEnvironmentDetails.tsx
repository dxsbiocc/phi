import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material'

import type { ManagedEnvironmentState } from '../../../../../shared/environmentTypes'
import type { PhiPluginEnvironmentStatus } from '../hooks/usePhiPlugins'
import { phiPluginEnvironmentStateLabel } from '../lib/phiPlugins'

export type PhiPluginEnvironmentBusyState = {
  envId: string
  kind: 'build' | 'rebuild'
}

export type PhiPluginEnvironmentDetailsProps = {
  environments: readonly PhiPluginEnvironmentStatus[]
  busyEnvironment: PhiPluginEnvironmentBusyState | null
  busyPluginId: string | null
  actionError: string | null
  onDismissError: () => void
  onBuild: (environment: PhiPluginEnvironmentStatus) => void
  onRebuild: (environment: PhiPluginEnvironmentStatus) => void
}

function environmentColor(
  state: ManagedEnvironmentState | undefined
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (state === 'building') return 'primary'
  if (state === 'ready') return 'success'
  if (state === 'failed') return 'error'
  if (state === 'drifted') return 'warning'
  return 'default'
}

function environmentBuildProgress(environment: PhiPluginEnvironmentStatus): string {
  const build = environment.build
  if (!build) return '正在启动构建…'
  return `${build.message} · ${build.progress.packagesDone} / ${build.progress.packages} 个包`
}

function environmentTitle(environment: PhiPluginEnvironmentStatus): string {
  if (environment.scope !== 'builtin') return environment.name
  if (environment.ref.startsWith('phi:python@')) {
    return `内置 Python 环境 · ${environment.name}`
  }
  if (environment.ref.startsWith('phi:r@')) return `内置 R 环境 · ${environment.name}`
  return `内置环境 · ${environment.name}`
}

function environmentScopeLabel(environment: PhiPluginEnvironmentStatus): string {
  if (environment.scope === 'builtin') return '与其他内置技能共享'
  if (environment.scope === 'private') return '插件私有'
  if (environment.scope === 'project') return '项目环境'
  return '技能专用'
}

function EnvironmentUsage({
  label,
  names
}: {
  label: string
  names: readonly string[]
}): React.JSX.Element | null {
  if (names.length === 0) return null
  return (
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
      {label}：{names.join('、')}
    </Typography>
  )
}

type EnvironmentCardProps = Pick<
  PhiPluginEnvironmentDetailsProps,
  'busyEnvironment' | 'busyPluginId' | 'onBuild' | 'onRebuild'
> & { environment: PhiPluginEnvironmentStatus }

function environmentActionState(
  environment: PhiPluginEnvironmentStatus,
  busyEnvironment: PhiPluginEnvironmentBusyState | null
): { building: boolean; rebuildable: boolean; showBuildAction: boolean } {
  const actionBusy =
    busyEnvironment !== null &&
    (busyEnvironment.envId === environment.envId || busyEnvironment.envId === environment.ref)
  const building =
    environment.state === 'building' ||
    (actionBusy && (busyEnvironment?.kind === 'rebuild' || environment.state === 'absent'))
  const rebuildable =
    (environment.state === 'failed' || environment.state === 'drifted') &&
    Boolean(environment.envId)
  const showBuildAction =
    environment.state === 'absent' ||
    environment.state === 'building' ||
    (actionBusy && busyEnvironment?.kind === 'build')
  return { building, rebuildable, showBuildAction }
}

function EnvironmentMessages({
  environment,
  building
}: {
  environment: PhiPluginEnvironmentStatus
  building: boolean
}): React.JSX.Element {
  return (
    <>
      {building ? (
        <Typography variant="caption" color="primary" sx={{ display: 'block', mt: 0.5 }}>
          {environmentBuildProgress(environment)}
        </Typography>
      ) : null}
      {environment.warnings.map((warning) => (
        <Typography key={warning} variant="caption" color="warning.main" sx={{ display: 'block' }}>
          {warning}
        </Typography>
      ))}
      {environment.error ? (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {environment.error}
        </Typography>
      ) : null}
    </>
  )
}

function EnvironmentCardContent({
  environment,
  building
}: {
  environment: PhiPluginEnvironmentStatus
  building: boolean
}): React.JSX.Element {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 650 }}>{environmentTitle(environment)}</Typography>
        <Chip size="small" variant="outlined" label={environmentScopeLabel(environment)} />
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', fontFamily: 'var(--font-mono)' }}
      >
        {environment.ref}
      </Typography>
      {environment.description ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {environment.description}
        </Typography>
      ) : null}
      <EnvironmentUsage label="使用技能" names={environment.skillNames} />
      <EnvironmentUsage label="使用智能体" names={environment.agentNames} />
      <EnvironmentMessages environment={environment} building={building} />
    </Box>
  )
}

function EnvironmentCardActions({
  environment,
  busyPluginId,
  building,
  rebuildable,
  showBuildAction,
  onBuild,
  onRebuild
}: Omit<EnvironmentCardProps, 'busyEnvironment'> &
  ReturnType<typeof environmentActionState>): React.JSX.Element {
  const stateLabel = building
    ? phiPluginEnvironmentStateLabel('building')
    : environment.state
      ? phiPluginEnvironmentStateLabel(environment.state)
      : '状态未知'
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
      <Chip
        size="small"
        color={environmentColor(building ? 'building' : environment.state)}
        variant="outlined"
        label={stateLabel}
      />
      {showBuildAction ? (
        <Button
          size="small"
          variant="contained"
          disabled={building || busyPluginId !== null}
          startIcon={building ? <CircularProgress size={14} color="inherit" /> : undefined}
          onClick={() => onBuild(environment)}
        >
          {building ? '构建中…' : '查看估算并构建'}
        </Button>
      ) : null}
      {rebuildable ? (
        <Button
          size="small"
          variant="outlined"
          disabled={building || busyPluginId !== null}
          onClick={() => onRebuild(environment)}
        >
          {environment.state === 'failed' ? '重新构建' : '修复环境'}
        </Button>
      ) : null}
    </Stack>
  )
}

function EnvironmentCard(props: EnvironmentCardProps): React.JSX.Element {
  const { environment, busyEnvironment } = props
  const actionState = environmentActionState(environment, busyEnvironment)
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={1.5}
      data-phi-plugin-environment={environment.ref}
      sx={{
        alignItems: { xs: 'stretch', md: 'center' },
        p: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5
      }}
    >
      <EnvironmentCardContent environment={environment} building={actionState.building} />
      <EnvironmentCardActions {...props} {...actionState} />
    </Stack>
  )
}

function EnvironmentDetailsContent(props: PhiPluginEnvironmentDetailsProps): React.JSX.Element {
  return (
    <Box sx={{ minWidth: 0 }}>
      {props.actionError ? (
        <Alert severity="error" variant="outlined" onClose={props.onDismissError} sx={{ mb: 1.25 }}>
          {props.actionError}
        </Alert>
      ) : null}
      {props.environments.length > 0 ? (
        <Stack spacing={1}>
          {props.environments.map((environment) => (
            <EnvironmentCard
              key={`${environment.ref}:${environment.name}`}
              environment={environment}
              {...props}
            />
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          此插件不需要托管环境。
        </Typography>
      )}
    </Box>
  )
}

export function PhiPluginEnvironmentDetails({
  ...props
}: PhiPluginEnvironmentDetailsProps): React.JSX.Element {
  return (
    <Box
      component="section"
      data-phi-plugin-environment-details="true"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: '160px minmax(0, 1fr)' },
        columnGap: 2,
        rowGap: 0.75,
        alignItems: 'start'
      }}
    >
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{ fontWeight: 700, lineHeight: '24px' }}
      >
        环境
      </Typography>
      <EnvironmentDetailsContent {...props} />
    </Box>
  )
}
