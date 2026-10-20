import { environmentUi } from '../lib/environmentUi'
import { getUiLocale, useUiLanguage } from '../../../lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
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
  ManagedEnvironmentEntry
} from '../../../../../shared/environmentTypes'
import { errorMessage } from '../../../../../shared/errorCodes'
import { EnvironmentBuildConfirmDialog } from '../../../components/EnvironmentBuildConfirmDialog'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { useSessionStore } from '../../../stores/sessionStore'
import { ManagedEnvironmentsSection } from './ManagedEnvironmentsSection'
import { ManagedEnvironmentDetail } from './ManagedEnvironmentDetail'
import {
  buildEnvironmentSections,
  formatEnvironmentSize,
  managedEnvironmentHostResources
} from '../lib/environmentPanel'
import {
  readManagedEnvironmentCache,
  refreshManagedEnvironmentCache
} from '../lib/managedEnvironmentApi'

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
  return (
    <ConfirmationDialog open={action !== null} onClose={working ? undefined : onClose}>
      <DialogTitle>{action ? actionDialogTitle(action) : ''}</DialogTitle>
      <DialogContent>
        {action?.kind === 'remove' ? (
          <DialogContentText>
            {environmentUi.thisDeletesTheEnvironmentDirectoryAndFreesLocal}
          </DialogContentText>
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

  const confirmAction = async (): Promise<void> => {
    const action = pendingAction
    if (!action) return
    setActionWorking(true)
    setNotice(null)
    setManagedError(null)
    if ('environment' in action) setBusyEnvId(action.environment.envId)
    try {
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
      } else if (action.kind === 'remove') {
        const result = await window.api.removeManagedEnvironment(action.environment.envId)
        setNotice(
          () => () =>
            result.removed
              ? environmentUi.removedValue(action.environment.label ?? action.environment.ref)
              : environmentUi.theEnvironmentWasNotRemoved
        )
      } else {
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
          error={managedError?.() ?? null}
          onBack={() => setSelectedEnvironmentId(null)}
          onBuild={() => setPendingAction({ kind: 'build', environment: selectedEnvironment })}
          onRebuild={() => void rebuild(selectedEnvironment)}
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
