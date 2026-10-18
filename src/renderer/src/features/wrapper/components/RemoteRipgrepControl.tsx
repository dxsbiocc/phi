import { useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
import { Alert, Button, Chip, LinearProgress, Stack, Typography } from '@mui/material'

import type { RemoteRipgrepCapabilityProfile } from '../../../../../shared/remoteRuntimeRootTypes'
import type {
  RemoteRipgrepProgress,
  RemoteRipgrepResult,
  RemoteRipgrepStatusResult
} from '../../../../../shared/remoteRipgrepTypes'

type RipgrepResult = RemoteRipgrepStatusResult | RemoteRipgrepResult

export type RemoteRipgrepUiState =
  | { phase: 'idle' }
  | { phase: 'running'; progress?: RemoteRipgrepProgress & { requestId?: string } }
  | { phase: 'done'; result: RipgrepResult }

export interface RemoteRipgrepControlProps {
  cachedStatus?: RemoteRipgrepCapabilityProfile
  state: RemoteRipgrepUiState
  disabled?: boolean
  onInstall: (
    confirmedWarnings?: RemoteRipgrepResult['warningCodes'],
    forceManaged?: boolean
  ) => void
}

function visibleStatus(
  cached: RemoteRipgrepCapabilityProfile | undefined,
  state: RemoteRipgrepUiState
): RemoteRipgrepCapabilityProfile {
  if (state.phase !== 'done') return cached ?? { status: 'unchecked' }
  const { result } = state
  if (result.status === 'system' && result.version) {
    return { status: 'system', version: result.version }
  }
  if (
    (result.status === 'managed' ||
      result.status === 'installed' ||
      result.status === 'already-installed') &&
    result.version
  ) {
    return { status: 'managed', version: result.version }
  }
  if (result.status === 'not-installed') return { status: 'not-installed' }
  return cached ?? { status: 'unchecked' }
}

function statusLabel(status: RemoteRipgrepCapabilityProfile): string {
  if (status.status === 'system') return remoteSetupCopy.systemRipgrepVersion(status.version)
  if (status.status === 'managed') return remoteSetupCopy.managedRipgrepVersion(status.version)
  if (status.status === 'not-installed') return remoteSetupCopy.notInstalled
  return remoteSetupCopy.notChecked
}

function statusColor(status: RemoteRipgrepCapabilityProfile): 'default' | 'success' | 'warning' {
  if (status.status === 'system' || status.status === 'managed') return 'success'
  if (status.status === 'not-installed') return 'warning'
  return 'default'
}

function installResult(state: RemoteRipgrepUiState): RemoteRipgrepResult | undefined {
  if (state.phase !== 'done' || !('warningCodes' in state.result)) return undefined
  return state.result
}

function StatusHeader({ status }: { status: RemoteRipgrepCapabilityProfile }): React.JSX.Element {
  useUiLanguage()
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
      <Stack spacing={0.25} sx={{ flex: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 750 }}>
          ripgrep
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {remoteSetupCopy.ripgrepHelp}
        </Typography>
      </Stack>
      <Chip
        size="small"
        variant="outlined"
        color={statusColor(status)}
        label={statusLabel(status)}
      />
    </Stack>
  )
}

function Feedback({
  state,
  result
}: {
  state: RemoteRipgrepUiState
  result?: RemoteRipgrepResult
}): React.JSX.Element {
  useUiLanguage()
  if (state.phase === 'running') {
    return (
      <Stack spacing={0.5}>
        <Typography variant="caption">
          {state.progress?.message ?? remoteSetupCopy.checkingRipgrep}
        </Typography>
        <LinearProgress />
      </Stack>
    )
  }
  if (!result) return <></>
  const severity =
    result.status === 'failed'
      ? 'error'
      : result.status === 'needs-confirmation'
        ? 'warning'
        : 'success'
  return <Alert severity={severity}>{result.message}</Alert>
}

export function RemoteRipgrepControl({
  cachedStatus,
  state,
  disabled,
  onInstall
}: RemoteRipgrepControlProps): React.JSX.Element {
  useUiLanguage()
  const status = visibleStatus(cachedStatus, state)
  const result = installResult(state)
  const warnings = result?.status === 'needs-confirmation' ? result.warningCodes : undefined
  const forceManaged = status.status === 'system'
  return (
    <Stack spacing={1.25}>
      <StatusHeader status={status} />
      <Typography variant="caption" color="text.secondary">
        {remoteSetupCopy.managedRipgrepHelp}
      </Typography>
      <Button
        size="small"
        variant="outlined"
        disabled={disabled || state.phase === 'running'}
        onClick={() => onInstall(warnings, forceManaged)}
        sx={{ alignSelf: 'flex-start', minHeight: 44 }}
      >
        {warnings
          ? remoteSetupCopy.useAnyway
          : forceManaged
            ? remoteSetupCopy.installManagedVersion
            : remoteSetupCopy.installRipgrep}
      </Button>
      <Feedback state={state} result={result} />
    </Stack>
  )
}
