import { useCallback, useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
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
import { EnvironmentBuildConfirmDialog } from '../../../components/EnvironmentBuildConfirmDialog'
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function actionDialogTitle(action: DestructiveAction): string {
  if (action.kind === 'remove')
    return `移除 ${action.environment.label ?? action.environment.ref}？`
  return '清理未引用环境？'
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
  return (
    <Dialog open={action !== null} onClose={working ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{action ? actionDialogTitle(action) : ''}</DialogTitle>
      <DialogContent>
        {action?.kind === 'remove' ? (
          <DialogContentText>
            将删除此环境前缀并释放本机空间。只有无引用且未在构建的环境可以移除。
          </DialogContentText>
        ) : null}
        {action?.kind === 'clean' ? (
          <DialogContentText>
            将通过 Phi 的垃圾回收移除所有未引用环境和可清理日志；被锁定或正在构建的环境会跳过。
          </DialogContentText>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button disabled={working} onClick={onClose}>
          取消
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={working}
          onClick={onConfirm}
          startIcon={working ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {working ? '处理中…' : '确认'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export function EnvironmentSettingsPanel({
  snapshot,
  loading,
  redetecting,
  onRedetect,
  onSavePath
}: EnvironmentSettingsPanelProps): React.JSX.Element {
  const projectCwd = useSessionStore((state) =>
    state.activeProjectLocation?.kind === 'local' ? state.activeCwd || undefined : undefined
  )
  const cachedManaged = readManagedEnvironmentCache(projectCwd)
  const requestRef = useRef(0)
  const [managed, setManaged] = useState<ManagedEnvironmentEntry[]>(() => [
    ...(cachedManaged ?? [])
  ])
  const [managedLoading, setManagedLoading] = useState(() => !cachedManaged)
  const [managedError, setManagedError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [actionWorking, setActionWorking] = useState(false)
  const [busyEnvId, setBusyEnvId] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
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
          throw new Error('环境管理接口尚未加载，请完全退出并重新打开 Phi 后再试')
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
        setManagedError(`无法读取托管环境：${errorMessage(cause)}`)
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
      setRefreshError(`重新检测失败：${errorMessage(cause)}`)
    }
  }

  const rebuild = async (environment: ManagedEnvironmentEntry): Promise<void> => {
    setActionWorking(true)
    setBusyEnvId(environment.envId)
    setManagedError(null)
    setNotice(null)
    try {
      await window.api.rebuildManagedEnvironment(environment.envId)
      setNotice(`已重新构建 ${environment.label ?? environment.ref}。`)
      await loadManaged({ force: true })
    } catch (cause) {
      setManagedError(`无法重新构建环境：${errorMessage(cause)}`)
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
          `已开始构建 ${action.environment.label ?? action.environment.ref}，请到后台任务查看进度。`
        )
      } else if (action.kind === 'remove') {
        const result = await window.api.removeManagedEnvironment(action.environment.envId)
        setNotice(
          result.removed
            ? `已移除 ${action.environment.label ?? action.environment.ref}。`
            : '环境未被移除。'
        )
      } else {
        const result = await window.api.cleanManagedEnvironments()
        setNotice(
          `清理完成：移除 ${result.removed.length} 个环境，释放 ${formatEnvironmentSize(result.bytesFreed)}` +
            (result.skipped.length ? `，跳过 ${result.skipped.length} 个。` : '。')
        )
      }
      setPendingAction(null)
      await loadManaged({ force: true })
    } catch (cause) {
      const verb = action.kind === 'build' ? '构建' : action.kind === 'remove' ? '移除' : '清理'
      setManagedError(`${verb}失败：${errorMessage(cause)}`)
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
            {notice}
          </Alert>
        ) : null}
        <ManagedEnvironmentDetail
          environment={selectedEnvironment}
          hostResources={selectedHostResources}
          hostBusy={loading || redetecting}
          busy={actionWorking || busyEnvId === selectedEnvironment.envId}
          error={managedError}
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
          <Typography variant="h5">环境</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            管理 Phi 的可复现环境。Jupyter、Nextflow 与容器运行时会自动检测，并显示在对应环境中。
          </Typography>
          {snapshot?.scannedAt ? (
            <Typography variant="caption" color="text.secondary">
              最近检测 {new Date(snapshot.scannedAt).toLocaleString()}
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
          重新检测
        </Button>
      </Box>

      {refreshError ? (
        <Alert severity="error" variant="outlined">
          {refreshError}
        </Alert>
      ) : null}
      {notice ? (
        <Alert severity="success" variant="outlined" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}

      <ManagedEnvironmentsSection
        environments={managedEnvironments}
        snapshot={snapshot}
        loading={managedLoading || actionWorking}
        error={managedError}
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
