import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import type { ManagedEnvironmentEntry } from '../../../../../shared/environmentTypes'
import {
  formatBuildEstimate,
  formatEnvironmentSize,
  managedEnvironmentConsumerKindLabel,
  managedEnvironmentSourceLabel,
  managedEnvironmentStateLabel
} from '../lib/environmentPanel'

type ManagedEnvironmentsSectionProps = {
  environments: readonly ManagedEnvironmentEntry[]
  loading: boolean
  error: string | null
  busyEnvId: string | null
  onRetry: () => void
  onBuild: (entry: ManagedEnvironmentEntry) => void
  onRebuild: (entry: ManagedEnvironmentEntry) => void
  onRemove: (entry: ManagedEnvironmentEntry) => void
  onClean: () => void
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
  busy,
  onBuild,
  onRebuild,
  onRemove
}: {
  environment: ManagedEnvironmentEntry
  busy: boolean
  onBuild: () => void
  onRebuild: () => void
  onRemove: () => void
}): React.JSX.Element {
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

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
      <Stack spacing={1.25}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}
        >
          <Typography variant="body1" sx={{ fontWeight: 700 }}>
            {environmentTitle(environment)}
          </Typography>
          <Chip
            size="small"
            color={stateColor(environment.state)}
            variant="outlined"
            label={managedEnvironmentStateLabel(environment.state)}
          />
          <Chip
            size="small"
            variant="outlined"
            label={managedEnvironmentSourceLabel(environment.source)}
          />
          {environment.overrideFrom?.map((ref) => (
            <Chip key={ref} size="small" variant="outlined" label={`替代 ${ref}`} />
          ))}
        </Stack>

        <Box sx={{ minWidth: 0 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}
          >
            {environment.ref} · {environment.envId}
          </Typography>
          {environment.description ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {environment.description}
            </Typography>
          ) : null}
        </Box>

        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            占用空间：{formatEnvironmentSize(environment.sizeBytes)}
          </Typography>
          {environment.state === 'absent' ? (
            <Typography variant="body2" color="text.secondary">
              {formatBuildEstimate(environment.estimate)}
            </Typography>
          ) : null}
        </Stack>

        <Box>
          <Typography variant="caption" color="text.secondary">
            使用方
          </Typography>
          <Stack
            direction="row"
            spacing={0.75}
            useFlexGap
            sx={{ mt: 0.5, flexWrap: 'wrap', rowGap: 0.75 }}
          >
            {environment.consumers.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                无
              </Typography>
            ) : (
              environment.consumers.map((consumer, index) => (
                <Chip
                  key={`${consumer.kind}:${consumer.name}:${index}`}
                  size="small"
                  label={`${managedEnvironmentConsumerKindLabel(consumer.kind)} · ${consumer.label ?? consumer.name}`}
                />
              ))
            )}
          </Stack>
        </Box>

        <Box>
          <Typography variant="caption" color="text.secondary">
            引用
          </Typography>
          {environment.referrers.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              无引用，可安全移除
            </Typography>
          ) : (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.5, wordBreak: 'break-all' }}
            >
              {environment.referrers.join(' · ')}
            </Typography>
          )}
        </Box>

        {environment.error ? (
          <Alert severity="error" variant="outlined">
            {environment.error}
          </Alert>
        ) : null}

        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          {canBuild ? (
            <Button size="small" variant="contained" disabled={busy} onClick={onBuild}>
              查看估算并构建
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
              {busy ? '重新构建中…' : '重新构建'}
            </Button>
          ) : null}
          {environment.state === 'building' ? (
            <Button size="small" variant="outlined" disabled>
              到后台任务查看进度
            </Button>
          ) : null}
          <Button size="small" color="error" disabled={busy || !removable} onClick={onRemove}>
            移除
          </Button>
          {!removable && environment.state !== 'building' && environment.state !== 'absent' ? (
            <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
              有引用的环境不能移除
            </Typography>
          ) : null}
        </Stack>
      </Stack>
    </Paper>
  )
}

export function ManagedEnvironmentsSection({
  environments,
  loading,
  error,
  busyEnvId,
  onRetry,
  onBuild,
  onRebuild,
  onRemove,
  onClean
}: ManagedEnvironmentsSectionProps): React.JSX.Element {
  return (
    <Stack component="section" spacing={1.25} aria-labelledby="managed-environments-title">
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}
      >
        <Box>
          <Typography id="managed-environments-title" variant="h6">
            托管环境
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Phi 按锁文件构建并隔离这些环境。构建进度统一显示在后台任务面板。
          </Typography>
        </Box>
        <Button size="small" color="warning" disabled={loading} onClick={onClean}>
          清理未引用环境
        </Button>
      </Stack>

      {error ? (
        <Alert severity="error" variant="outlined" action={<Button onClick={onRetry}>重试</Button>}>
          {error}
        </Alert>
      ) : null}

      {loading && environments.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 5 }}>
          <CircularProgress size={28} />
        </Box>
      ) : environments.length === 0 ? (
        <Alert severity="info" variant="outlined">
          暂无可管理的环境。
        </Alert>
      ) : (
        <Stack spacing={1.25}>
          {environments.map((environment) => (
            <EnvironmentCard
              key={`${environment.ref}:${environment.envId}`}
              environment={environment}
              busy={busyEnvId === environment.envId}
              onBuild={() => onBuild(environment)}
              onRebuild={() => onRebuild(environment)}
              onRemove={() => onRemove(environment)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  )
}
