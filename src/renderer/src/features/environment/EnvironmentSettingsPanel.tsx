import { environmentUi } from './lib/environmentUi'
import { getUiLocale, useUiLanguage } from '../../lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import type {
  EnvironmentSnapshot,
  EnvironmentToolId,
  ManagedEnvironmentCheckResult,
  ManagedEnvironmentEntry
} from '../../../../shared/environmentTypes'
import { errorMessage } from '../../../../shared/errorCodes'
import { EnvironmentBuildConfirmDialog } from '../../components/EnvironmentBuildConfirmDialog'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { useSessionStore } from '../../stores/sessionStore'
import { InstalledEnvironmentsSection } from './components/InstalledEnvironmentsSection'
import { ManagedEnvironmentsSection } from './components/ManagedEnvironmentsSection'
import { ManagedEnvironmentDetail } from './components/ManagedEnvironmentDetail'
import {
  buildEnvironmentSections,
  formatEnvironmentSize,
  managedEnvironmentHostResources
} from './lib/environmentPanel'
import {
  readManagedEnvironmentCache,
  refreshManagedEnvironmentCache
} from './lib/managedEnvironmentApi'

type PendingAction =
  | { kind: 'build'; environment: ManagedEnvironmentEntry }
  | { kind: 'remove'; environment: ManagedEnvironmentEntry }
  | { kind: 'clean' }

type DestructiveAction = Exclude<PendingAction, { kind: 'build' }>

export type EnvironmentSettingsPanelProps = {
  snapshot: EnvironmentSnapshot | null
  loading: boolean
  redetecting: boolean
  onRedetect: () => Promise<void>
  onSavePath: (toolId: EnvironmentToolId, path: string | null) => Promise<void>
}

type LoadManagedOptions = {
  blocking?: boolean
  force?: boolean
  includeDynamic?: boolean
}

function actionDialogTitle(action: DestructiveAction): string {
  if (action.kind === 'remove')
    return environmentUi.removeValue(action.environment.label ?? action.environment.ref)
  return environmentUi.cleanUpUnreferencedEnvironments
}

function affectedLabels(environment: ManagedEnvironmentEntry): string[] {
  const fromConsumers = environment.consumers.map((item) => item.label || item.name)
  const seen = new Set(fromConsumers)
  for (const ref of environment.referrers) {
    if (!seen.has(ref)) {
      seen.add(ref)
      fromConsumers.push(ref)
    }
  }
  return fromConsumers
}

function DestructiveActionDialog({
  action,
  working,
  onClose,
  onConfirm
}: {
  action: DestructiveAction | null
  working: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  useUiLanguage()
  const removeTarget = action?.kind === 'remove' ? action.environment : null
  const affected = removeTarget ? affectedLabels(removeTarget) : []
  const referenceCount = removeTarget
    ? Math.max(removeTarget.referrers.length, removeTarget.consumers.length)
    : 0

  return (
    <ConfirmationDialog open={action !== null} onClose={working ? undefined : onClose}>
      <DialogTitle>{action ? actionDialogTitle(action) : ''}</DialogTitle>
      <DialogContent>
        {removeTarget ? (
          <Stack spacing={1.5}>
            <DialogContentText>
              {environmentUi.thisDeletesTheEnvironmentDirectoryAndFreesLocal}
              {removeTarget.sizeBytes !== undefined
                ? ` (${formatEnvironmentSize(removeTarget.sizeBytes)})`
                : ''}
            </DialogContentText>
            {referenceCount > 0 ? (
              <Alert severity="warning" variant="outlined">
                <Stack spacing={1}>
                  <Typography variant="body2">
                    {environmentUi.referencedDeleteWarning(referenceCount)}
                  </Typography>
                  {affected.length > 0 ? (
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      {affected.map((item) => (
                        <Chip key={item} size="small" variant="outlined" label={item} />
                      ))}
                    </Stack>
                  ) : null}
                </Stack>
              </Alert>
            ) : null}
          </Stack>
        ) : null}
        {action?.kind === 'clean' ? (
          <DialogContentText>
            {environmentUi.phiWillRemoveUnreferencedEnvironmentsAndEligibleLogs}
          </DialogContentText>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button disabled={working} onClick={onClose}>
          {environmentUi.cancel}
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={working}
          onClick={onConfirm}
          startIcon={working ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {working ? environmentUi.working : environmentUi.confirm}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}

export function EnvironmentSettingsPanel({
  snapshot,
  loading,
  redetecting,
  onRedetect,
  onSavePath
}: EnvironmentSettingsPanelProps): React.JSX.Element {
  useUiLanguage()
  const projectCwd = useSessionStore((state) =>
    state.activeProjectLocation?.kind === 'local' ? state.activeCwd || undefined : undefined
  )
  const cachedManaged = readManagedEnvironmentCache(projectCwd)
  const requestRef = useRef(0)
  const [managed, setManaged] = useState<ManagedEnvironmentEntry[]>(() => [
    ...(cachedManaged ?? [])
  ])
  const [managedLoading, setManagedLoading] = useState(() => !cachedManaged)
  const [managedError, setManagedError] = useState<(() => string) | null>(null)
  const [notice, setNotice] = useState<(() => string) | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [actionWorking, setActionWorking] = useState(false)
  const [busyEnvId, setBusyEnvId] = useState<string | null>(null)
  const [checkingEnvId, setCheckingEnvId] = useState<string | null>(null)
  const [trimmingCache, setTrimmingCache] = useState(false)
  const [checkResults, setCheckResults] = useState<Record<string, ManagedEnvironmentCheckResult>>(
    {}
  )
  const [refreshError, setRefreshError] = useState<(() => string) | null>(null)
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null)

  const loadManaged = useCallback(
    async ({
      blocking = true,
      force = false,
      includeDynamic = true
    }: LoadManagedOptions = {}): Promise<void> => {
      const request = ++requestRef.current
      if (blocking) setManagedLoading(true)
      setManagedError(null)
      try {
        if (typeof window.api.listManagedEnvironments !== 'function') {
          throw new Error(environmentUi.environmentManagementIsNotLoadedQuitAndReopen)
        }
        const environments = await refreshManagedEnvironmentCache(
          projectCwd,
          () => window.api.listManagedEnvironments(projectCwd, includeDynamic),
          { force, scope: includeDynamic ? 'full' : 'summary' }
        )
        if (request !== requestRef.current) return
        setManaged([...environments])
      } catch (cause) {
        if (request !== requestRef.current) return
        setManagedError(
          () => () => environmentUi.unableToLoadManagedEnvironmentsValue(errorMessage(cause))
        )
      } finally {
        if (request === requestRef.current) setManagedLoading(false)
      }
    },
    [projectCwd]
  )

  useEffect(() => {
    const cached = readManagedEnvironmentCache(projectCwd)
    const timer = window.setTimeout(() => {
      void (async () => {
        await loadManaged({ blocking: !cached, includeDynamic: false })
        await loadManaged({ blocking: false, force: true, includeDynamic: true })
      })()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      requestRef.current += 1
    }
  }, [loadManaged, projectCwd])

  const sections = buildEnvironmentSections(managed)
  const managedEnvironments = sections[0].items
  const selectedEnvironment = selectedEnvironmentId
    ? (managedEnvironments.find((environment) => environment.envId === selectedEnvironmentId) ??
      null)
    : null
  const selectedHostResources = selectedEnvironment
    ? managedEnvironmentHostResources(selectedEnvironment, snapshot)
    : { dependencies: [], tools: [] }

  const refreshAll = async (): Promise<void> => {
    setRefreshError(null)
    try {
      await onRedetect()
      await loadManaged({ force: true })
    } catch (cause) {
      setRefreshError(() => () => environmentUi.detectionFailedValue(errorMessage(cause)))
    }
  }

  const rebuild = async (environment: ManagedEnvironmentEntry): Promise<void> => {
    setActionWorking(true)
    setBusyEnvId(environment.envId)
    setManagedError(null)
    setNotice(null)
    try {
      await window.api.rebuildManagedEnvironment(environment.envId)
      setCheckResults((prev) => {
        const next = { ...prev }
        delete next[environment.envId]
        return next
      })
      setNotice(() => () => environmentUi.rebuiltValue(environment.label ?? environment.ref))
      await loadManaged({ force: true })
    } catch (cause) {
      setManagedError(
        () => () => environmentUi.unableToRebuildEnvironmentValue(errorMessage(cause))
      )
    } finally {
      setBusyEnvId(null)
      setActionWorking(false)
    }
  }

  const checkEnvironment = async (environment: ManagedEnvironmentEntry): Promise<void> => {
    setCheckingEnvId(environment.envId)
    setManagedError(null)
    setNotice(null)
    try {
      const result = await window.api.checkManagedEnvironment(environment.envId)
      setCheckResults((prev) => ({ ...prev, [environment.envId]: result }))
      const label = environment.label ?? environment.ref
      if (result.ok) {
        setNotice(() => () => environmentUi.checkPassed(label))
      } else {
        setManagedError(
          () => () => environmentUi.checkFailed(label, result.problems.slice(0, 3).join('; '))
        )
        await loadManaged({ force: true, blocking: false })
      }
    } catch (cause) {
      setManagedError(
        () => () =>
          environmentUi.valueFailedValue(environmentUi.checkEnvironment, errorMessage(cause))
      )
    } finally {
      setCheckingEnvId(null)
    }
  }

  const trimCache = async (): Promise<void> => {
    setTrimmingCache(true)
    setManagedError(null)
    setNotice(null)
    try {
      const result = await window.api.trimManagedEnvironmentCache()
      setNotice(
        () => () => environmentUi.trimCacheComplete(formatEnvironmentSize(result.bytesFreed))
      )
      await loadManaged({ force: true, blocking: false })
    } catch (cause) {
      setManagedError(
        () => () => environmentUi.valueFailedValue(environmentUi.trimCache, errorMessage(cause))
      )
    } finally {
      setTrimmingCache(false)
    }
  }

  const executePendingAction = async (action: PendingAction): Promise<void> => {
    if (action.kind === 'build') {
      await window.api.buildManagedEnvironment(
        action.environment.ref,
        projectCwd,
        action.environment.pluginId
      )
      setNotice(
        () => () =>
          environmentUi.startedBuildingValueViewProgressInBackgroundJobs(
            action.environment.label ?? action.environment.ref
          )
      )
      return
    }
    if (action.kind === 'remove') {
      const force = action.environment.referrers.length > 0 ? { force: true } : undefined
      const result = await window.api.removeManagedEnvironment(action.environment.envId, force)
      setCheckResults((prev) => {
        const next = { ...prev }
        delete next[action.environment.envId]
        return next
      })
      setNotice(
        () => () =>
          result.removed
            ? environmentUi.removedValue(action.environment.label ?? action.environment.ref)
            : environmentUi.theEnvironmentWasNotRemoved
      )
      return
    }
    const result = await window.api.cleanManagedEnvironments()
    setNotice(
      () => () =>
        environmentUi.cleanupComplete(
          result.removed.length,
          formatEnvironmentSize(result.bytesFreed),
          result.skipped.length
        )
    )
  }

  const confirmAction = async (): Promise<void> => {
    const action = pendingAction
    if (!action) return
    setActionWorking(true)
    setNotice(null)
    setManagedError(null)
    if ('environment' in action) setBusyEnvId(action.environment.envId)
    try {
      await executePendingAction(action)
      setPendingAction(null)
      await loadManaged({ force: true })
    } catch (cause) {
      const verb = (): string =>
        action.kind === 'build'
          ? environmentUi.build
          : action.kind === 'remove'
            ? environmentUi.remove
            : environmentUi.cleanUp
      setManagedError(() => () => environmentUi.valueFailedValue(verb(), errorMessage(cause)))
      setPendingAction(null)
    } finally {
      setBusyEnvId(null)
      setActionWorking(false)
    }
  }

  if (selectedEnvironment) {
    return (
      <Stack spacing={2.5}>
        {notice ? (
          <Alert severity="success" variant="outlined" onClose={() => setNotice(null)}>
            {notice()}
          </Alert>
        ) : null}
        <ManagedEnvironmentDetail
          environment={selectedEnvironment}
          hostResources={selectedHostResources}
          hostBusy={loading || redetecting}
          busy={actionWorking || busyEnvId === selectedEnvironment.envId}
          checking={checkingEnvId === selectedEnvironment.envId}
          checkResult={checkResults[selectedEnvironment.envId]}
          error={managedError?.() ?? null}
          onBack={() => setSelectedEnvironmentId(null)}
          onBuild={() => setPendingAction({ kind: 'build', environment: selectedEnvironment })}
          onRebuild={() => void rebuild(selectedEnvironment)}
          onCheck={() => void checkEnvironment(selectedEnvironment)}
          onRemove={() => setPendingAction({ kind: 'remove', environment: selectedEnvironment })}
          onSaveHostPath={onSavePath}
        />
        <EnvironmentBuildConfirmDialog
          environment={pendingAction?.kind === 'build' ? pendingAction.environment : null}
          working={actionWorking}
          onClose={() => setPendingAction(null)}
          onConfirm={() => void confirmAction()}
        />
        <DestructiveActionDialog
          action={pendingAction?.kind === 'build' ? null : pendingAction}
          working={actionWorking}
          onClose={() => setPendingAction(null)}
          onConfirm={() => void confirmAction()}
        />
      </Stack>
    )
  }

  return (
    <Stack spacing={2.5}>
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'space-between',
          gap: 2,
          flexDirection: { xs: 'column', md: 'row' }
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">{environmentUi.environments}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {environmentUi.manageReproduciblePhiEnvironmentsJupyterNextflowAndContainer}
          </Typography>
          {snapshot?.scannedAt ? (
            <Typography variant="caption" color="text.secondary">
              {environmentUi.lastChecked}{' '}
              {new Date(snapshot.scannedAt).toLocaleString(getUiLocale())}
            </Typography>
          ) : null}
        </Box>
        <Button
          size="small"
          variant="outlined"
          disabled={loading || redetecting || managedLoading || actionWorking}
          onClick={() => void refreshAll()}
          startIcon={redetecting ? <CircularProgress size={14} color="inherit" /> : undefined}
          sx={{ minHeight: 40, flexShrink: 0 }}
        >
          {environmentUi.detectAgain}
        </Button>
      </Box>

      {refreshError ? (
        <Alert severity="error" variant="outlined">
          {refreshError()}
        </Alert>
      ) : null}
      {notice ? (
        <Alert severity="success" variant="outlined" onClose={() => setNotice(null)}>
          {notice()}
        </Alert>
      ) : null}

      <ManagedEnvironmentsSection
        environments={managedEnvironments}
        snapshot={snapshot}
        loading={managedLoading || actionWorking}
        error={managedError?.() ?? null}
        busyEnvId={busyEnvId}
        onRetry={() => void loadManaged({ force: true })}
        onBuild={(environment) => setPendingAction({ kind: 'build', environment })}
        onRebuild={(environment) => void rebuild(environment)}
        onRemove={(environment) => setPendingAction({ kind: 'remove', environment })}
        onClean={() => setPendingAction({ kind: 'clean' })}
        onOpen={(environment) => setSelectedEnvironmentId(environment.envId)}
      />

      <InstalledEnvironmentsSection
        environments={managedEnvironments}
        loading={managedLoading || actionWorking}
        busyEnvId={busyEnvId}
        checkingEnvId={checkingEnvId}
        trimmingCache={trimmingCache}
        checkResults={checkResults}
        onBuild={(environment) => setPendingAction({ kind: 'build', environment })}
        onCheck={(environment) => void checkEnvironment(environment)}
        onRebuild={(environment) => void rebuild(environment)}
        onRemove={(environment) => setPendingAction({ kind: 'remove', environment })}
        onOpen={(environment) => setSelectedEnvironmentId(environment.envId)}
        onClean={() => setPendingAction({ kind: 'clean' })}
        onTrimCache={() => void trimCache()}
      />

      <EnvironmentBuildConfirmDialog
        environment={pendingAction?.kind === 'build' ? pendingAction.environment : null}
        working={actionWorking}
        onClose={() => setPendingAction(null)}
        onConfirm={() => void confirmAction()}
      />
      <DestructiveActionDialog
        action={pendingAction?.kind === 'build' ? null : pendingAction}
        working={actionWorking}
        onClose={() => setPendingAction(null)}
        onConfirm={() => void confirmAction()}
      />
    </Stack>
  )
}
