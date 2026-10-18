import { useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
import { Alert, Box, Button, Stack, Typography } from '@mui/material'
import { GoAlert, GoCheckCircle, GoInfo, GoXCircle } from 'react-icons/go'

import type { RemoteRuntimeRootCheckResult } from '../../../../../shared/remoteRuntimeRootTypes'
import {
  formatRemoteRuntimeRootSpace,
  type RemoteRuntimeRootUiStatus
} from '../lib/remoteRuntimeRootUi'

type RowTone = 'ok' | 'warning' | 'error' | 'info'
type BooleanPresentation = { tone: RowTone; text: string }

function ResultIcon({ tone }: { tone: RowTone }): React.JSX.Element {
  useUiLanguage()
  if (tone === 'ok') return <GoCheckCircle color="var(--mui-palette-success-main)" />
  if (tone === 'warning') return <GoAlert color="var(--mui-palette-warning-main)" />
  if (tone === 'error') return <GoXCircle color="var(--mui-palette-error-main)" />
  return <GoInfo color="var(--mui-palette-info-main)" />
}

function ResultRow({ tone, text }: { tone: RowTone; text: string }): React.JSX.Element {
  useUiLanguage()
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
      <Box sx={{ display: 'flex', mt: '2px' }}>
        <ResultIcon tone={tone} />
      </Box>
      <Typography variant="caption">{text}</Typography>
    </Stack>
  )
}

function existenceText(result: RemoteRuntimeRootCheckResult): string {
  if (result.exists) return remoteSetupCopy.directoryExists
  if (result.ancestorWritable && result.nearestExistingAncestor) {
    return remoteSetupCopy.creatableDirectory(result.nearestExistingAncestor)
  }
  return remoteSetupCopy.directoryCannotCreate
}

function booleanPresentation(
  value: boolean | null,
  positive: string,
  negative: string,
  unknown: string,
  positiveTone: RowTone = 'ok',
  negativeTone: RowTone = 'warning'
): BooleanPresentation {
  if (value === null) return { tone: 'info', text: unknown }
  return value ? { tone: positiveTone, text: positive } : { tone: negativeTone, text: negative }
}

function PathRows({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  useUiLanguage()
  return (
    <>
      <ResultRow
        tone={result.expandedPath ? 'ok' : 'error'}
        text={remoteSetupCopy.resolvedPath(result.expandedPath)}
      />
      <ResultRow
        tone={result.exists || result.ancestorWritable ? 'ok' : 'error'}
        text={existenceText(result)}
      />
    </>
  )
}

function SafetyRows({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  useUiLanguage()
  const owner = booleanPresentation(
    result.ownedByCurrentUser,
    remoteSetupCopy.ownedByCurrentUser,
    remoteSetupCopy.notOwned,
    remoteSetupCopy.ownershipUnknown
  )
  const writable = booleanPresentation(
    result.groupOrOtherWritable,
    remoteSetupCopy.groupWritable,
    remoteSetupCopy.groupNotWritable,
    remoteSetupCopy.groupWritableUnknown,
    'warning',
    'ok'
  )
  const symlink = booleanPresentation(
    result.hasSymlink,
    remoteSetupCopy.pathContainsSymlink,
    remoteSetupCopy.pathNoSymlink,
    remoteSetupCopy.symlinkUnknown,
    'warning',
    'ok'
  )
  return (
    <>
      <ResultRow {...owner} />
      <ResultRow {...writable} />
      <ResultRow {...symlink} />
    </>
  )
}

function StorageRows({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  useUiLanguage()
  const space = formatRemoteRuntimeRootSpace(result.availableKiB)
  const spaceWarning = result.warnings.some(
    ({ code }) => code === 'low-space' || code === 'high-disk-use'
  )
  const executable = booleanPresentation(
    result.executable,
    remoteSetupCopy.probeExecutable,
    remoteSetupCopy.notExecutable,
    remoteSetupCopy.executionUnknown
  )
  return (
    <>
      <ResultRow tone="info" text={remoteSetupCopy.filesystemValue(result.fsType)} />
      <ResultRow
        tone={spaceWarning ? 'warning' : result.availableKiB === null ? 'info' : 'ok'}
        text={remoteSetupCopy.remainingSpace(space, result.diskUsePercent)}
      />
      <ResultRow {...executable} />
      <ResultRow
        tone={result.sharedFilesystem ? 'info' : 'ok'}
        text={
          result.sharedFilesystem
            ? remoteSetupCopy.sharedStorageUnknownVisibility
            : result.sharedFilesystem === false
              ? remoteSetupCopy.notSharedStorage
              : remoteSetupCopy.sharedStorageUnknown
        }
      />
    </>
  )
}

function CheckedRows({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  useUiLanguage()
  return (
    <Stack spacing={0.5}>
      <PathRows result={result} />
      <SafetyRows result={result} />
      <StorageRows result={result} />
    </Stack>
  )
}

function IssueAlerts({ result }: { result: RemoteRuntimeRootCheckResult }): React.JSX.Element {
  useUiLanguage()
  return (
    <Stack spacing={0.75}>
      {result.hardErrors.map((issue) => (
        <Alert key={issue.code} severity="error">
          {issue.message} {remoteSetupCopy.runtimeRootCorrectionHelp}
        </Alert>
      ))}
      {result.warnings.map((warning) => (
        <Alert key={warning.code} severity="warning">
          {warning.message} {remoteSetupCopy.consequencePrefix}
          {warning.consequence}
        </Alert>
      ))}
    </Stack>
  )
}

export function RemoteRuntimeRootResults({
  status,
  onConfirmWarnings
}: {
  status: RemoteRuntimeRootUiStatus
  onConfirmWarnings?: () => void
}): React.JSX.Element {
  useUiLanguage()
  if (status.phase === 'idle') return <ResultRow tone="info" text={remoteSetupCopy.notChecked} />
  if (status.phase === 'running')
    return <ResultRow tone="info" text={remoteSetupCopy.checkingProgress} />
  if (status.phase === 'timed-out')
    return <ResultRow tone="warning" text={remoteSetupCopy.checkTimedOut} />
  if (status.phase === 'failed')
    return <ResultRow tone="error" text={remoteSetupCopy.checkIncomplete} />
  const { result } = status
  return (
    <Stack spacing={1}>
      <CheckedRows result={result} />
      <IssueAlerts result={result} />
      {result.warnings.length > 0 && result.hardErrors.length === 0 && onConfirmWarnings && (
        <Button size="small" color="warning" variant="outlined" onClick={onConfirmWarnings}>
          {remoteSetupCopy.useAnyway}
        </Button>
      )}
    </Stack>
  )
}
