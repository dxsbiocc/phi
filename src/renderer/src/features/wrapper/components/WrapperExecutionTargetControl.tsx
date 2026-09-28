import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useEffect, useRef, useState } from 'react'

import type { RemoteDoctorOptions } from '../../../../../shared/remoteDoctorTypes'
import type { Project, ProjectRemoteConnection, RemoteHostProfile } from '../../../types'
import { PhiIcons } from '../../../icons'
import {
  EMPTY_HPC_DRAFT,
  hpcDraftError,
  hpcDraftFromSettings,
  hpcSettingsFromDraft,
  type HpcDraft
} from '../lib/remoteHpcDraft'
import { WrapperHpcSettingsFields } from './WrapperHpcSettingsFields'
import { RemoteDoctorPanel } from './RemoteDoctorPanel'
import { RemoteDependencyActions } from './RemoteDependencyActions'
import type { RemoteDoctorUiState } from '../lib/remoteDoctorUi'

const ServerIcon = PhiIcons.settings.remoteExecution
const ExpandIcon = PhiIcons.action.expand

interface Props {
  project: Project
  busy?: boolean
  compact?: boolean
  onUpdateRemoteConnection?: (
    projectId: string,
    connectionId: string,
    patch: ProjectRemoteConnection
  ) => Promise<void>
  onUpdateRemoteDefaults?: (
    projectId: string,
    defaults: { defaultRemoteConnectionId?: string | null; remoteWorkspaceRoot?: string | null }
  ) => Promise<void>
  onOpenRemoteSettings?: () => void
  onSaved?: () => void
}

/** Local projects opt into server compute; SSH projects only configure how their bound server runs Wrappers. */
export function WrapperExecutionTargetControl({
  project,
  busy = false,
  compact = false,
  onUpdateRemoteConnection,
  onUpdateRemoteDefaults,
  onOpenRemoteSettings,
  onSaved
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [hosts, setHosts] = useState<RemoteHostProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [hostProfileId, setHostProfileId] = useState('')
  const [remoteRoot, setRemoteRoot] = useState('')
  const [hpc, setHpc] = useState<HpcDraft>(EMPTY_HPC_DRAFT)
  const [localInputRoot, setLocalInputRoot] = useState('')
  const [remoteInputRoot, setRemoteInputRoot] = useState('')
  const [environmentState, setEnvironmentState] = useState<RemoteDoctorUiState>({ phase: 'idle' })
  const [installConfirmOpen, setInstallConfirmOpen] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installStatus, setInstallStatus] = useState<{
    message: string
    severity: 'success' | 'error'
  } | null>(null)
  const environmentSequence = useRef(0)

  const isRemoteProject = project.location.kind === 'ssh'
  const boundHostProfileId =
    project.location.kind === 'ssh' ? project.location.hostProfileId : undefined
  const boundHostAvailable = hosts.some((host) => host.id === boundHostProfileId)
  const connections = project.remoteConnections ?? []
  const selected = connections.find((item) => item.id === connectionId)
  const configured = boundHostProfileId
    ? (connections.find(
        (item) =>
          item.id === project.defaultRemoteConnectionId && item.hostProfileId === boundHostProfileId
      ) ?? connections.find((item) => item.hostProfileId === boundHostProfileId))
    : connections.find((item) => item.id === project.defaultRemoteConnectionId)
  const environmentKeyFor = (nextflowBin: string): string =>
    JSON.stringify([
      hostProfileId,
      remoteRoot.trim(),
      hpc.scheduler,
      hpc.controller,
      hpc.runtime,
      nextflowBin.trim()
    ])
  const environmentKey = environmentKeyFor(hpc.nextflowBin)
  const checkingEnvironment =
    environmentState.phase === 'running' && environmentState.key === environmentKey
  const environmentReport =
    environmentState.phase === 'done' && environmentState.key === environmentKey
      ? environmentState.report
      : null

  function closeDialog(): void {
    if (saving || installing) return
    environmentSequence.current += 1
    setInstallConfirmOpen(false)
    setOpen(false)
  }

  async function checkEnvironment(nextflowBin = hpc.nextflowBin): Promise<void> {
    const root = remoteRoot.trim()
    if (!hosts.some((host) => host.id === hostProfileId)) return setError('请选择可用的 SSH 服务器')
    if (!root.startsWith('/') || /[\r\n\0]/.test(root)) {
      return setError('服务器工作目录必须是绝对路径')
    }
    const key = environmentKeyFor(nextflowBin)
    const requestId = ++environmentSequence.current
    const options: RemoteDoctorOptions = {
      scope: 'full',
      scheduler: hpc.scheduler,
      controller: hpc.controller,
      runtime: hpc.runtime,
      ...(nextflowBin.trim() ? { nextflowBin: nextflowBin.trim() } : {})
    }
    setError(null)
    setEnvironmentState({ phase: 'running', key })
    try {
      const report = await window.api.remoteDoctor(hostProfileId, root, options)
      if (environmentSequence.current === requestId) {
        setEnvironmentState({ phase: 'done', key, report })
      }
    } catch {
      if (environmentSequence.current === requestId) {
        setEnvironmentState({
          phase: 'failed',
          key,
          message: '运行环境检查未完成，请确认服务器和网络状态后重试。'
        })
      }
    }
  }

  async function autoInstallNextflow(): Promise<void> {
    setInstallConfirmOpen(false)
    setInstalling(true)
    setInstallStatus(null)
    try {
      const result = await window.api.installRemoteNextflow(hostProfileId)
      setHpc((current) => ({ ...current, nextflowBin: result.path }))
      setInstallStatus({
        severity: 'success',
        message: result.alreadyInstalled
          ? `已发现 Nextflow：${result.path}。请保存运行方式。`
          : `Nextflow 已安装到 ${result.path}。请保存运行方式。`
      })
      await checkEnvironment(result.path)
    } catch (cause) {
      setInstallStatus({
        severity: 'error',
        message: cause instanceof Error ? cause.message : 'Nextflow 安装未完成，请改为手动安装'
      })
    } finally {
      setInstalling(false)
    }
  }

  function chooseConnection(id: string): void {
    const connection = connections.find((item) => item.id === id)
    setConnectionId(connection?.id ?? '')
    setHostProfileId(boundHostProfileId ?? connection?.hostProfileId ?? '')
    setHpc(
      connection?.hpc
        ? hpcDraftFromSettings(connection.hpc)
        : isRemoteProject
          ? { ...EMPTY_HPC_DRAFT, scheduler: 'local', controller: 'login' }
          : EMPTY_HPC_DRAFT
    )
    setLocalInputRoot(connection?.inputPathMapping?.localRoot ?? '')
    setRemoteInputRoot(connection?.inputPathMapping?.remoteRoot ?? '')
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api
      .listRemoteHosts()
      .then((items) => {
        if (!cancelled) setHosts(items)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [open])

  function openDialog(): void {
    chooseConnection(configured?.id ?? '')
    setRemoteRoot(
      project.location.kind === 'ssh'
        ? project.location.canonicalRoot
        : (project.remoteWorkspaceRoot ?? '')
    )
    setError(null)
    environmentSequence.current += 1
    setEnvironmentState({ phase: 'idle' })
    setInstallStatus(null)
    setLoading(true)
    setOpen(true)
  }

  async function save(): Promise<void> {
    const root = remoteRoot.trim()
    const host = hosts.find((item) => item.id === hostProfileId)
    const localRoot = localInputRoot.trim()
    const serverRoot = remoteInputRoot.trim()
    const hpcError = hpcDraftError(hpc)
    if (!host) {
      return setError(
        isRemoteProject ? '项目绑定的 SSH 服务器已不可用，请先恢复服务器配置' : '请选择 SSH 服务器'
      )
    }
    if (!root.startsWith('/') || /[\r\n\0]/.test(root)) {
      return setError('服务器工作目录必须是绝对路径')
    }
    if (!isRemoteProject && Boolean(localRoot) !== Boolean(serverRoot)) {
      return setError('本机和服务器输入根目录需要同时填写')
    }
    if (!isRemoteProject && localRoot && !localRoot.startsWith('/')) {
      return setError('本机输入根目录必须是绝对路径')
    }
    if (!isRemoteProject && serverRoot && !serverRoot.startsWith('/')) {
      return setError('服务器输入根目录必须是绝对路径')
    }
    if (hpcError) return setError(hpcError)

    const id = selected?.id ?? crypto.randomUUID()
    const connection: ProjectRemoteConnection = {
      id,
      label: selected?.hostProfileId === host.id ? selected.label : host.label,
      hostProfileId: host.id,
      hpc: hpcSettingsFromDraft(hpc),
      ...(!isRemoteProject && localRoot && serverRoot
        ? { inputPathMapping: { localRoot, remoteRoot: serverRoot } }
        : {})
    }
    setSaving(true)
    setError(null)
    try {
      if (onUpdateRemoteConnection) {
        await onUpdateRemoteConnection(project.id, id, connection)
      } else {
        await window.api.updateProjectRemoteConnection(project.id, id, connection)
      }
      setConnectionId(id)
      const defaults = {
        defaultRemoteConnectionId: id,
        ...(!isRemoteProject ? { remoteWorkspaceRoot: root } : {})
      }
      if (onUpdateRemoteDefaults) {
        await onUpdateRemoteDefaults(project.id, defaults)
      } else {
        await window.api.updateProjectRemoteDefaults(project.id, defaults)
      }
      environmentSequence.current += 1
      setOpen(false)
      onSaved?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<ServerIcon fontSize="small" />}
          disabled={busy}
          onClick={openDialog}
        >
          {isRemoteProject
            ? 'Wrapper 运行方式'
            : configured
              ? compact
                ? `服务器：${configured.label}`
                : `远程计算：${configured.label}`
              : compact
                ? '选择服务器'
                : '设置远程计算'}
        </Button>
        {!compact && (
          <Typography variant="caption" color="text.secondary">
            {isRemoteProject
              ? 'Wrapper 自动在本项目服务器运行；这里可设置 Slurm 和软件环境。'
              : '本地项目仍默认在本机运行；仅在要求服务器运行时使用此目标。'}
          </Typography>
        )}
      </Stack>
      <Dialog open={open} onClose={closeDialog} maxWidth="sm" fullWidth>
        <DialogTitle>
          {isRemoteProject ? '远程项目的 Wrapper 运行方式' : '本地项目的远程计算目标'}
        </DialogTitle>
        <DialogContent dividers>
          <Box
            component="fieldset"
            disabled={installing}
            sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}
          >
            <Stack spacing={2} sx={{ pt: 0.5 }}>
              <Typography variant="body2" color="text.secondary">
                {isRemoteProject
                  ? '该项目的 Wrapper 固定在绑定的服务器和项目目录运行。'
                  : '服务器执行只影响明确指定为远程的 Wrapper。项目文件仍在本机，Phi 不会自动上传数据。'}
              </Typography>
              {!isRemoteProject && connections.length > 0 && (
                <TextField
                  select
                  size="small"
                  fullWidth
                  label="已保存的计算目标"
                  value={connectionId}
                  onChange={(event) => chooseConnection(event.target.value)}
                >
                  <MenuItem value="">新建计算目标</MenuItem>
                  {connections.map((connection) => (
                    <MenuItem key={connection.id} value={connection.id}>
                      {connection.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              {isRemoteProject ? (
                <TextField
                  size="small"
                  fullWidth
                  label="SSH 服务器"
                  value={project.remoteHostAlias ?? boundHostProfileId ?? ''}
                  slotProps={{ input: { readOnly: true } }}
                  error={!loading && !boundHostAvailable}
                  helperText={
                    !loading && !boundHostAvailable
                      ? '绑定的服务器已不可用，请在远程设置中恢复'
                      : ''
                  }
                />
              ) : (
                <TextField
                  select
                  required
                  size="small"
                  fullWidth
                  label="SSH 服务器"
                  value={hostProfileId}
                  disabled={loading}
                  onChange={(event) => setHostProfileId(event.target.value)}
                  helperText={
                    hosts.length === 0 && !loading
                      ? '先在“设置 → 远程”添加服务器'
                      : '使用系统 OpenSSH 配置中的主机和认证方式'
                  }
                >
                  <MenuItem value="">选择服务器</MenuItem>
                  {hosts.map((host) => (
                    <MenuItem key={host.id} value={host.id}>
                      {host.label} · {host.hostAlias}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              {!loading &&
                (isRemoteProject ? !boundHostAvailable : hosts.length === 0) &&
                onOpenRemoteSettings && (
                  <Button
                    size="small"
                    onClick={() => {
                      closeDialog()
                      onOpenRemoteSettings()
                    }}
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    添加 SSH 服务器
                  </Button>
                )}
              <TextField
                required
                size="small"
                fullWidth
                label="服务器工作目录"
                value={remoteRoot}
                onChange={
                  isRemoteProject ? undefined : (event) => setRemoteRoot(event.target.value)
                }
                placeholder="/data/lab/project"
                helperText={
                  isRemoteProject
                    ? '与远程项目绑定的目录一致'
                    : 'Wrapper 的任务记录和输出保存在该目录下'
                }
                slotProps={isRemoteProject ? { input: { readOnly: true } } : undefined}
                sx={{ '& input': { fontFamily: 'var(--font-mono)' } }}
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField
                  select
                  size="small"
                  fullWidth
                  label="任务调度"
                  value={hpc.scheduler}
                  onChange={(event) =>
                    setHpc({
                      ...hpc,
                      scheduler: event.target.value as HpcDraft['scheduler'],
                      ...(event.target.value === 'local' ? { controller: 'login' as const } : {})
                    })
                  }
                >
                  <MenuItem value="slurm">Slurm 集群</MenuItem>
                  <MenuItem value="local">直接在服务器运行</MenuItem>
                </TextField>
                <TextField
                  select
                  size="small"
                  fullWidth
                  label="软件环境"
                  value={hpc.runtime}
                  onChange={(event) =>
                    setHpc({ ...hpc, runtime: event.target.value as HpcDraft['runtime'] })
                  }
                >
                  <MenuItem value="singularity">Singularity / Apptainer</MenuItem>
                  <MenuItem value="conda">Conda</MenuItem>
                  <MenuItem value="docker">Docker</MenuItem>
                </TextField>
              </Stack>
              <Accordion variant="outlined" disableGutters>
                <AccordionSummary expandIcon={<ExpandIcon fontSize="small" />}>
                  <Typography variant="body2">更多运行参数</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <WrapperHpcSettingsFields value={hpc} onChange={setHpc} advancedOnly />
                </AccordionDetails>
              </Accordion>
              {!isRemoteProject && (
                <Accordion variant="outlined" disableGutters>
                  <AccordionSummary expandIcon={<ExpandIcon fontSize="small" />}>
                    <Typography variant="body2">已有数据的路径映射（可选）</Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Stack spacing={1.5}>
                      <Typography variant="caption" color="text.secondary">
                        仅当同一份数据已在服务器上时填写。Phi 不会上传本地文件。
                      </Typography>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                        <TextField
                          size="small"
                          fullWidth
                          label="本机输入根目录"
                          value={localInputRoot}
                          onChange={(event) => setLocalInputRoot(event.target.value)}
                        />
                        <TextField
                          size="small"
                          fullWidth
                          label="服务器对应根目录"
                          value={remoteInputRoot}
                          onChange={(event) => setRemoteInputRoot(event.target.value)}
                        />
                      </Stack>
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              )}
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={loading || saving || checkingEnvironment}
                  onClick={() => void checkEnvironment()}
                >
                  {checkingEnvironment ? '检查中…' : '检查运行环境'}
                </Button>
                <Typography variant="caption" color="text.secondary">
                  只检查目录和命令；不会安装或修改服务器。
                </Typography>
              </Stack>
              <RemoteDoctorPanel state={environmentState} targetKey={environmentKey} />
              {environmentReport && (
                <RemoteDependencyActions
                  report={environmentReport}
                  installing={installing}
                  onInstallNextflow={() => setInstallConfirmOpen(true)}
                />
              )}
              {installStatus && (
                <Alert severity={installStatus.severity}>{installStatus.message}</Alert>
              )}
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={saving || installing}>
            取消
          </Button>
          <Button
            variant="contained"
            onClick={() => void save()}
            disabled={saving || loading || installing}
          >
            {saving ? '保存中…' : isRemoteProject ? '保存运行方式' : '保存计算目标'}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={installConfirmOpen}
        onClose={() => !installing && setInstallConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>自动安装 Nextflow</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mt: 1 }}>
            Phi 将从 Nextflow 官方安装地址获取安装脚本，在所选服务器的当前账号下执行，并把程序放入
            ~/.local/bin。不会使用 sudo，也不会安装 Java、Slurm 或容器运行时。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInstallConfirmOpen(false)} disabled={installing}>
            取消
          </Button>
          <Button
            variant="contained"
            onClick={() => void autoInstallNextflow()}
            disabled={installing}
          >
            确认安装
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
