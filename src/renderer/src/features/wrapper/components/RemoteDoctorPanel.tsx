import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { localizeRemoteSetupMessage, remoteSetupCopy } from '../lib/remoteSetupCopy'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography
} from '@mui/material'

import type { RemoteDoctorStatus } from '../../../../../shared/remoteDoctorTypes'
import type { RemoteDoctorUiState } from '../lib/remoteDoctorUi'
import { remoteRuntimeRootResultStatus } from '../lib/remoteRuntimeRootUi'
import { RemoteCapabilityProfileSummary } from './RemoteCapabilityProfileSummary'
import { RemoteRuntimeRootResults } from './RemoteRuntimeRootResults'

const CHECK_LABELS: Record<string, string> = {
  get ssh() {
    return remoteSetupCopy.sshConnection
  },
  get sftp() {
    return remoteSetupCopy.fileUploadTool
  },
  get path() {
    return remoteSetupCopy.remoteDirectory
  },
  get path_read() {
    return remoteSetupCopy.directoryReadAccess
  },
  get path_write() {
    return remoteSetupCopy.directoryWriteAccess
  },
  get shell() {
    return remoteSetupCopy.loginShell
  },
  nextflow: 'Nextflow',
  java: 'Java',
  get slurm_submit() {
    return remoteSetupCopy.slurmSubmit
  },
  get slurm_status() {
    return remoteSetupCopy.slurmStatus
  },
  get slurm_detail() {
    return remoteSetupCopy.slurmDetails
  },
  get slurm_cancel() {
    return remoteSetupCopy.slurmCancel
  },
  get runtime() {
    return remoteSetupCopy.containerOrCondaRuntime
  }
}

const STATUS_LABELS: Record<RemoteDoctorStatus, string> = {
  get ok() {
    return remoteSetupCopy.ok
  },
  get warning() {
    return remoteSetupCopy.warning
  },
  get error() {
    return remoteSetupCopy.needsAttention
  }
}

const STATUS_COLORS: Record<RemoteDoctorStatus, 'success' | 'warning' | 'error'> = {
  ok: 'success',
  warning: 'warning',
  error: 'error'
}

export function RemoteDoctorPanel({
  state,
  targetKey,
  onOpenRemoteSettings
}: {
  state: RemoteDoctorUiState
  targetKey: string
  onOpenRemoteSettings?: () => void
}): React.JSX.Element | null {
  useUiLanguage()
  if (state.phase === 'idle' || state.key !== targetKey) return null
  if (state.phase === 'running') {
    return (
      <Alert severity="info" icon={<CircularProgress size={18} />} sx={{ mt: 1.5 }}>
        {remoteSetupCopy.checkingServer}
      </Alert>
    )
  }
  if (state.phase === 'failed') {
    return (
      <Alert
        severity="error"
        sx={{ mt: 1.5 }}
        action={
          onOpenRemoteSettings ? (
            <Button size="small" onClick={onOpenRemoteSettings}>
              {remoteSetupCopy.remoteSettings}
            </Button>
          ) : undefined
        }
      >
        {localizeRemoteSetupMessage(state.message)}
      </Alert>
    )
  }

  const { report } = state
  const sshOk = report.checks.some((check) => check.id === 'ssh' && check.status === 'ok')
  const rootCheck = report.runtimeRootCheck
  const cachedRoot = report.capabilityProfile?.runtimeRoot
  const runtimeRootUnchecked = !rootCheck && !report.capabilityProfile?.runtimeRoot
  const cachedRootIssue = Boolean(
    cachedRoot &&
    (cachedRoot.status !== 'checked' ||
      cachedRoot.hasHardError ||
      cachedRoot.warningCodes.length > 0)
  )
  const runtimeRootError = Boolean(rootCheck?.hardErrors.length || cachedRoot?.hasHardError)
  const hasWarning =
    report.checks.some((check) => check.status === 'warning') ||
    runtimeRootUnchecked ||
    cachedRootIssue ||
    Boolean(rootCheck && (rootCheck.status !== 'checked' || rootCheck.warnings.length > 0))
  const summary = !sshOk
    ? remoteSetupCopy.sshFailed
    : !report.ok || runtimeRootError
      ? remoteSetupCopy.sshPartial
      : hasWarning
        ? remoteSetupCopy.checkCompletedWithWarnings
        : remoteSetupCopy.checkPassed
  const checkedAt = new Date(report.checkedAt)

  return (
    <Paper variant="outlined" sx={{ mt: 1.5, p: 1.5, bgcolor: 'background.default' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {summary}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {remoteSetupCopy.checkedAtPrefix}
          {Number.isNaN(checkedAt.getTime())
            ? report.checkedAt
            : checkedAt.toLocaleString(getUiLocale())}
        </Typography>
        {!sshOk && onOpenRemoteSettings ? (
          <Button size="small" onClick={onOpenRemoteSettings}>
            {remoteSetupCopy.remoteSettings}
          </Button>
        ) : null}
      </Stack>
      <Divider sx={{ my: 1 }} />
      {report.capabilityProfile && (
        <>
          <RemoteCapabilityProfileSummary profile={report.capabilityProfile} />
          <Divider sx={{ my: 1 }} />
        </>
      )}
      {report.runtimeRootCheck && (
        <>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
            {remoteSetupCopy.runtimeRootCheck}
          </Typography>
          <RemoteRuntimeRootResults
            status={remoteRuntimeRootResultStatus(report.runtimeRootCheck)}
          />
          <Divider sx={{ my: 1 }} />
        </>
      )}
      {runtimeRootUnchecked && !report.capabilityProfile && (
        <>
          <Typography variant="caption">{remoteSetupCopy.runtimeRootUnchecked}</Typography>
          <Divider sx={{ my: 1 }} />
        </>
      )}
      <Stack spacing={1.25}>
        {report.checks.map((check) => (
          <Box key={check.id}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip
                size="small"
                variant="outlined"
                color={STATUS_COLORS[check.status]}
                label={STATUS_LABELS[check.status]}
              />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {CHECK_LABELS[check.id] ?? check.id}: {check.message}
              </Typography>
            </Stack>
            {check.suggestion && (
              <Typography variant="caption" color="text.secondary" sx={{ ml: 6, display: 'block' }}>
                {check.suggestion}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Paper>
  )
}
