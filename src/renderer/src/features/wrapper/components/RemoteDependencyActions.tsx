import { useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
import { Alert, Button, Link, Stack, Typography } from '@mui/material'
import { GoCopy } from 'react-icons/go'

import type { RemoteDoctorReport } from '../../../../../shared/remoteDoctorTypes'

interface RemoteDependencyActionsProps {
  report: RemoteDoctorReport
  installing: boolean
  onInstallNextflow: () => void
}

interface NextflowActionsProps {
  remediation: string
  showInstall: boolean
  javaReady: boolean
  installing: boolean
  onInstallNextflow: () => void
}

function copySuggestion(suggestion: string): void {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  void navigator.clipboard.writeText(suggestion).catch(() => undefined)
}

function NextflowActions({
  remediation,
  showInstall,
  javaReady,
  installing,
  onInstallNextflow
}: NextflowActionsProps): React.JSX.Element {
  useUiLanguage()
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      {showInstall && (
        <Button
          size="small"
          variant="outlined"
          disabled={installing || !javaReady}
          onClick={onInstallNextflow}
        >
          {installing ? remoteSetupCopy.installing : remoteSetupCopy.installNextflow}
        </Button>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<GoCopy aria-hidden="true" />}
        onClick={() => copySuggestion(remediation)}
      >
        {remoteSetupCopy.copySuggestion}
      </Button>
      <Link
        href="https://docs.seqera.io/nextflow/install"
        target="_blank"
        rel="noopener noreferrer"
        variant="body2"
      >
        {remoteSetupCopy.manualInstallInstructions}
      </Link>
    </Stack>
  )
}

function NextflowRemediation({
  status,
  suggestion,
  javaReady,
  installing,
  onInstallNextflow
}: {
  status: 'warning' | 'error'
  suggestion?: string
  javaReady: boolean
  installing: boolean
  onInstallNextflow: () => void
}): React.JSX.Element {
  useUiLanguage()
  const remediation = suggestion?.trim() || remoteSetupCopy.nextflowFallback
  return (
    <Alert severity={status === 'error' ? 'warning' : 'info'} variant="outlined">
      <Stack spacing={0.75}>
        <Typography variant="body2">
          {status === 'error'
            ? remoteSetupCopy.nextflowRequired
            : remoteSetupCopy.nextflowMissingOnLogin}
        </Typography>
        <Typography component="code" variant="caption" sx={{ userSelect: 'text' }}>
          {remediation}
        </Typography>
        <NextflowActions
          remediation={remediation}
          showInstall={status === 'error'}
          javaReady={javaReady}
          installing={installing}
          onInstallNextflow={onInstallNextflow}
        />
        <Typography variant="caption">{remoteSetupCopy.nextflowRequirements}</Typography>
      </Stack>
    </Alert>
  )
}

function DependencyWarnings({
  javaMissing,
  slurmMissing,
  runtimeMissing,
  sftpMissing
}: {
  javaMissing: boolean
  slurmMissing: boolean
  runtimeMissing: boolean
  sftpMissing: boolean
}): React.JSX.Element {
  useUiLanguage()
  return (
    <>
      {javaMissing && (
        <Alert severity="warning" variant="outlined">
          {remoteSetupCopy.javaRequired}
        </Alert>
      )}
      {slurmMissing && (
        <Alert severity="warning" variant="outlined">
          {remoteSetupCopy.slurmRequired}
        </Alert>
      )}
      {runtimeMissing && (
        <Alert severity="warning" variant="outlined">
          {remoteSetupCopy.runtimeRequired}
        </Alert>
      )}
      {sftpMissing && (
        <Alert severity="warning" variant="outlined">
          {remoteSetupCopy.sftpRequired}
        </Alert>
      )}
    </>
  )
}

/** Run readiness is shown after an explicit Wrapper environment check, never in the SSH host list. */
export function RemoteDependencyActions({
  report,
  installing,
  onInstallNextflow
}: RemoteDependencyActionsProps): React.JSX.Element | null {
  useUiLanguage()
  const problem = (id: string): boolean =>
    report.checks.some((check) => check.id === id && check.status !== 'ok')
  const nextflow = report.checks.find((check) => check.id === 'nextflow')
  const javaReady = report.checks.some((check) => check.id === 'java' && check.status === 'ok')
  const slurmMissing = ['slurm_submit', 'slurm_status', 'slurm_detail', 'slurm_cancel'].some((id) =>
    report.checks.some((check) => check.id === id && check.status === 'error')
  )
  const runtimeMissing = report.checks.some(
    (check) => check.id === 'runtime' && check.status === 'error'
  )
  if (
    !problem('nextflow') &&
    !problem('java') &&
    !slurmMissing &&
    !runtimeMissing &&
    !problem('sftp')
  ) {
    return null
  }

  return (
    <Stack spacing={1.25}>
      {nextflow && nextflow.status !== 'ok' && (
        <NextflowRemediation
          status={nextflow.status}
          suggestion={nextflow.suggestion}
          javaReady={javaReady}
          installing={installing}
          onInstallNextflow={onInstallNextflow}
        />
      )}
      <DependencyWarnings
        javaMissing={problem('java')}
        slurmMissing={slurmMissing}
        runtimeMissing={runtimeMissing}
        sftpMissing={problem('sftp')}
      />
    </Stack>
  )
}
