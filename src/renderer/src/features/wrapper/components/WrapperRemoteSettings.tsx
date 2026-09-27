import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useEffect, useMemo, useState } from 'react'

import type {
  OpenSshHost,
  Project,
  ProjectRemoteConnection,
  RemoteHostProfile
} from '../../../types'
import { PhiIcons } from '../../../icons'
import {
  EMPTY_HPC_DRAFT,
  hpcDraftError,
  hpcDraftFromSettings,
  hpcSettingsFromDraft,
  type HpcDraft
} from '../lib/remoteHpcDraft'
import {
  createRemoteDoctorUiController,
  remoteConnectionDoctorTarget,
  remoteDoctorTargetKey,
  remoteHostDoctorTarget,
  withHostDoctorState,
  type RemoteDoctorUiState
} from '../lib/remoteDoctorUi'
import { RemoteHostProfilesPanel, type RemoteHostDraft } from './RemoteHostProfilesPanel'
import { RemoteProjectConnectionRow } from './RemoteProjectConnectionRow'
import { WrapperHpcSettingsFields } from './WrapperHpcSettingsFields'

const AddIcon = PhiIcons.action.add

interface ConnectionDraft {
  id: string
  label: string
  hostProfileId: string
  hpc: HpcDraft
  localInputRoot: string
  remoteInputRoot: string
}

const EMPTY_DRAFT: ConnectionDraft = {
  id: '',
  label: '',
  hostProfileId: '',
  hpc: EMPTY_HPC_DRAFT,
  localInputRoot: '',
  remoteInputRoot: ''
}

function draftFromConnection(connection: ProjectRemoteConnection): ConnectionDraft {
  return {
    id: connection.id,
    label: connection.label,
    hostProfileId: connection.hostProfileId ?? '',
    hpc: hpcDraftFromSettings(connection.hpc),
    localInputRoot: connection.inputPathMapping?.localRoot ?? '',
    remoteInputRoot: connection.inputPathMapping?.remoteRoot ?? ''
  }
}

function draftValidationError(draft: ConnectionDraft): string | null {
  if (!draft.label.trim()) return '请填写连接名称'
  if (!draft.hostProfileId) return '请选择 SSH 服务器'
  if (Boolean(draft.localInputRoot) !== Boolean(draft.remoteInputRoot)) {
    return '本机根与服务器根需要同时填写'
  }
  if (draft.localInputRoot && !draft.localInputRoot.startsWith('/')) {
    return '本机映射根必须是绝对路径'
  }
  if (draft.remoteInputRoot && !draft.remoteInputRoot.startsWith('/')) {
    return '服务器映射根必须是 POSIX 绝对路径'
  }
  return hpcDraftError(draft.hpc)
}

interface ConnectionDialogProps {
  open: boolean
  draft: ConnectionDraft
  hosts: RemoteHostProfile[]
  busy: boolean
  error: string | null
  onChange: (next: ConnectionDraft) => void
  onCancel: () => void
  onSave: () => void
  allowInputMapping: boolean
}

function ConnectionDialog({
  open,
  draft,
  hosts,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
  allowInputMapping
}: ConnectionDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{draft.id ? '编辑远程连接' : '添加远程连接'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <TextField
            label="连接名称"
            size="small"
            fullWidth
            value={draft.label}
            onChange={(event) => onChange({ ...draft, label: event.target.value })}
            placeholder="例如：实验室 HPC"
          />
          <TextField
            select
            label="SSH 服务器"
            size="small"
            fullWidth
            value={draft.hostProfileId}
            onChange={(event) => onChange({ ...draft, hostProfileId: event.target.value })}
            helperText="使用你在 ~/.ssh/config 中配置的主机别名和认证方式"
          >
            <MenuItem value="">请选择服务器</MenuItem>
            {hosts.map((host) => (
              <MenuItem key={host.id} value={host.id}>
                {host.label} · {host.hostAlias}
              </MenuItem>
            ))}
          </TextField>
          <Divider />
          <WrapperHpcSettingsFields
            value={draft.hpc}
            onChange={(hpc) => onChange({ ...draft, hpc })}
          />
          {allowInputMapping && (
            <>
              <Divider />
              <Typography variant="body2" color="text.secondary">
                本地输入路径映射到服务器已有数据；Phi 不会上传文件。
              </Typography>
              <TextField
                label="本机输入根目录"
                size="small"
                fullWidth
                value={draft.localInputRoot}
                onChange={(event) => onChange({ ...draft, localInputRoot: event.target.value })}
                placeholder="/Users/me/project/data"
              />
              <TextField
                label="服务器对应根目录"
                size="small"
                fullWidth
                value={draft.remoteInputRoot}
                onChange={(event) => onChange({ ...draft, remoteInputRoot: event.target.value })}
                placeholder="/data/lab/project"
              />
            </>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button variant="contained" onClick={onSave} disabled={busy}>
          保存
        </Button>
      </DialogActions>
    </Dialog>
  )
}

interface WrapperRemoteSettingsProps {
  projects: Project[]
  updatingProjectId: string | null
  onUpdateRemoteConnection: (
    projectId: string,
    connectionId: string,
    patch: ProjectRemoteConnection | null
  ) => Promise<void>
  onUpdateRemoteDefaults: (
    projectId: string,
    defaults: { defaultRemoteConnectionId?: string | null; remoteWorkspaceRoot?: string | null }
  ) => Promise<void>
}

/** Global OpenSSH aliases and project-specific wrapper execution settings. */
export function WrapperRemoteSettingsSection({
  projects,
  updatingProjectId,
  onUpdateRemoteConnection,
  onUpdateRemoteDefaults
}: WrapperRemoteSettingsProps): React.JSX.Element {
  const [hosts, setHosts] = useState<RemoteHostProfile[]>([])
  const [openSshHosts, setOpenSshHosts] = useState<OpenSshHost[]>([])
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [hostDraft, setHostDraft] = useState<RemoteHostDraft>({
    id: '',
    label: '',
    hostAlias: '',
    hostname: '',
    user: '',
    port: '',
    identityFile: '',
    source: 'ssh-config'
  })
  const [hostDialogOpen, setHostDialogOpen] = useState(false)
  const [hostBusy, setHostBusy] = useState(false)
  const [hostError, setHostError] = useState<string | null>(null)
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null)
  const [showUnconfiguredLocalProjects, setShowUnconfiguredLocalProjects] = useState(false)
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_DRAFT)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [workspaceRootDrafts, setWorkspaceRootDrafts] = useState<Record<string, string>>({})
  const [doctorState, setDoctorState] = useState<RemoteDoctorUiState>({ phase: 'idle' })
  const [hostDoctorStates, setHostDoctorStates] = useState<Record<string, RemoteDoctorUiState>>({})
  const doctorController = useMemo(
    () =>
      createRemoteDoctorUiController(
        (hostProfileId, remotePath, options) =>
          window.api.remoteDoctor(hostProfileId, remotePath, options),
        (state) => {
          setDoctorState(state)
          setHostDoctorStates((previous) => withHostDoctorState(previous, state))
        }
      ),
    []
  )

  useEffect(() => {
    return (): void => doctorController.dispose()
  }, [doctorController])

  useEffect(() => {
    if (doctorState.phase === 'idle') return
    const keys = new Set(
      hosts.map((host) => remoteDoctorTargetKey(remoteHostDoctorTarget(host.id, host.hostAlias)))
    )
    for (const project of projects) {
      const remotePath = workspaceRootDrafts[project.id] ?? project.remoteWorkspaceRoot ?? ''
      for (const connection of project.remoteConnections ?? []) {
        const host = hosts.find((item) => item.id === connection.hostProfileId)
        if (host)
          keys.add(
            remoteDoctorTargetKey(
              remoteConnectionDoctorTarget(project.id, connection, host.hostAlias, remotePath)
            )
          )
      }
    }
    if (!keys.has(doctorState.key)) doctorController.invalidate()
  }, [doctorController, doctorState, hosts, projects, workspaceRootDrafts])

  useEffect(() => {
    let cancelled = false
    window.api
      .listRemoteHosts()
      .then((items) => {
        if (!cancelled) setHosts(items)
      })
      .catch((error: unknown) => {
        if (!cancelled) setHostError(error instanceof Error ? error.message : String(error))
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api
      .listOpenSshHosts()
      .then((items) => {
        if (!cancelled) setOpenSshHosts(items)
      })
      .catch((error: unknown) => {
        if (!cancelled) setConfigError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  async function reloadOpenSshHosts(): Promise<void> {
    setConfigLoading(true)
    setConfigError(null)
    try {
      const [profiles, discovered] = await Promise.all([
        window.api.listRemoteHosts(),
        window.api.listOpenSshHosts()
      ])
      setHosts(profiles)
      setOpenSshHosts(discovered)
      setHostDoctorStates({})
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error))
    } finally {
      setConfigLoading(false)
    }
  }

  async function saveHost(): Promise<void> {
    setHostBusy(true)
    setHostError(null)
    try {
      const rawPort = hostDraft.port.trim()
      if (rawPort && !/^\d+$/.test(rawPort)) throw new Error('SSH 端口必须为 1–65535 的整数')
      const connectionFields = {
        ...(hostDraft.user.trim() ? { user: hostDraft.user.trim() } : {}),
        ...(rawPort ? { port: Number(rawPort) } : {}),
        ...(hostDraft.identityFile.trim() ? { identityFile: hostDraft.identityFile.trim() } : {})
      }
      if (hostDraft.source === 'ssh-config') {
        await window.api.saveOpenSshHost({
          ...(hostDraft.id ? { originalAlias: hostDraft.hostAlias } : {}),
          alias: hostDraft.hostAlias,
          hostname: hostDraft.hostname,
          ...connectionFields
        })
        await reloadOpenSshHosts()
      } else {
        const profile = await window.api.saveRemoteHost({
          id: hostDraft.id,
          label: hostDraft.label,
          hostAlias: hostDraft.hostAlias,
          ...connectionFields
        })
        setHosts((prev) => [...prev.filter((item) => item.id !== profile.id), profile])
      }
      doctorController.invalidate()
      setHostDoctorStates({})
      setHostDraft({
        id: '',
        label: '',
        hostAlias: '',
        hostname: '',
        user: '',
        port: '',
        identityFile: '',
        source: 'ssh-config'
      })
      setHostDialogOpen(false)
    } catch (error) {
      setHostError(error instanceof Error ? error.message : String(error))
    } finally {
      setHostBusy(false)
    }
  }

  async function removeHost(id: string): Promise<void> {
    setHostBusy(true)
    setHostError(null)
    try {
      await window.api.deleteRemoteHost(id)
      setHosts((prev) => prev.filter((item) => item.id !== id))
      doctorController.invalidate()
      setHostDoctorStates((previous) => {
        const next = { ...previous }
        delete next[id]
        return next
      })
    } catch (error) {
      setHostError(error instanceof Error ? error.message : String(error))
    } finally {
      setHostBusy(false)
    }
  }

  function openAddHost(): void {
    setHostDraft({
      id: '',
      label: '',
      hostAlias: '',
      hostname: '',
      user: '',
      port: '',
      identityFile: '',
      source: 'ssh-config'
    })
    setHostError(null)
    setHostDialogOpen(true)
  }

  function openEditHost(host: RemoteHostProfile): void {
    const configured = openSshHosts.find((item) => item.alias === host.hostAlias)
    setHostDraft({
      id: host.id,
      label: host.label,
      hostAlias: host.hostAlias,
      hostname: configured?.hostname ?? host.hostAlias,
      user: host.user ?? configured?.user ?? '',
      port: host.port === undefined ? String(configured?.port ?? '') : String(host.port),
      identityFile: host.identityFile ?? configured?.identityFiles[0] ?? '',
      source: host.source === 'ssh-config' ? 'ssh-config' : 'phi'
    })
    setHostError(null)
    setHostDialogOpen(true)
  }

  function closeHostDialog(): void {
    if (hostBusy) return
    setHostDialogOpen(false)
    setHostError(null)
  }

  function openAddDialog(projectId: string): void {
    setDialogProjectId(projectId)
    setDraft(EMPTY_DRAFT)
    setDialogError(null)
  }

  function openEditDialog(projectId: string, connection: ProjectRemoteConnection): void {
    setDialogProjectId(projectId)
    setDraft(draftFromConnection(connection))
    setDialogError(null)
  }

  async function saveConnection(): Promise<void> {
    if (!dialogProjectId) return
    const validationError = draftValidationError(draft)
    if (validationError) {
      setDialogError(validationError)
      return
    }
    const connectionId = draft.id || crypto.randomUUID()
    const patch: ProjectRemoteConnection = {
      id: connectionId,
      label: draft.label.trim(),
      hostProfileId: draft.hostProfileId,
      hpc: hpcSettingsFromDraft(draft.hpc),
      ...(draft.localInputRoot && draft.remoteInputRoot
        ? {
            inputPathMapping: { localRoot: draft.localInputRoot, remoteRoot: draft.remoteInputRoot }
          }
        : {})
    }
    setDialogBusy(true)
    setDialogError(null)
    try {
      await onUpdateRemoteConnection(dialogProjectId, connectionId, patch)
      setDialogProjectId(null)
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }

  const unconfiguredLocalProjectIds = new Set(
    projects
      .filter(
        (project) =>
          project.location?.kind !== 'ssh' &&
          !project.remoteConnections?.length &&
          !project.remoteWorkspaceRoot
      )
      .map((project) => project.id)
  )
  const visibleProjects = projects.filter(
    (project) => showUnconfiguredLocalProjects || !unconfiguredLocalProjectIds.has(project.id)
  )

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">远程</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760 }}>
          直接使用 ~/.ssh/config 中的主机；新增和编辑会同步写回该文件。
        </Typography>
      </Box>

      <RemoteHostProfilesPanel
        hosts={hosts}
        openSshHosts={openSshHosts}
        configLoading={configLoading}
        configError={configError}
        dialogOpen={hostDialogOpen}
        draft={hostDraft}
        busy={hostBusy}
        error={hostError}
        doctorState={doctorState}
        hostDoctorStates={hostDoctorStates}
        onDraftChange={setHostDraft}
        onOpenAdd={openAddHost}
        onOpenEdit={openEditHost}
        onCloseDialog={closeHostDialog}
        onReloadConfig={() => void reloadOpenSshHosts()}
        onSave={() => void saveHost()}
        onDelete={(id) => void removeHost(id)}
        onTest={(host) =>
          void doctorController.check(remoteHostDoctorTarget(host.id, host.hostAlias))
        }
      />

      {unconfiguredLocalProjectIds.size > 0 && (
        <Button
          size="small"
          variant="text"
          onClick={() => setShowUnconfiguredLocalProjects((value) => !value)}
          sx={{ alignSelf: 'flex-start' }}
        >
          {showUnconfiguredLocalProjects
            ? '收起本地项目的远程 Wrapper 设置'
            : `为本地项目配置远程 Wrapper（${unconfiguredLocalProjectIds.size}）`}
        </Button>
      )}

      {projects.length === 0 ? (
        <Alert severity="info" variant="outlined">
          还没有项目
        </Alert>
      ) : (
        visibleProjects.map((project) => {
          const connections = project.remoteConnections ?? []
          const busy = updatingProjectId === project.id
          const workspaceRootDraft =
            workspaceRootDrafts[project.id] ?? project.remoteWorkspaceRoot ?? ''
          return (
            <Paper key={project.id} variant="outlined" sx={{ overflow: 'hidden' }}>
              <Box sx={{ px: 2.5, py: 2 }}>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      {project.name}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {project.workingDirectory}
                    </Typography>
                  </Box>
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    disabled={busy || hosts.length === 0}
                    onClick={() => openAddDialog(project.id)}
                  >
                    添加连接
                  </Button>
                </Stack>
              </Box>
              <Divider />
              <Box sx={{ px: 2.5, py: 2 }}>
                {connections.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    还没有配置远程连接
                  </Typography>
                ) : (
                  <Stack spacing={1}>
                    {connections.map((connection) => {
                      const host = hosts.find((item) => item.id === connection.hostProfileId)
                      return (
                        <RemoteProjectConnectionRow
                          key={connection.id}
                          projectId={project.id}
                          connection={connection}
                          host={host}
                          remotePath={workspaceRootDraft}
                          isDefault={connection.id === project.defaultRemoteConnectionId}
                          busy={busy}
                          doctorState={doctorState}
                          onTest={(target) => void doctorController.check(target)}
                          onEdit={() => openEditDialog(project.id, connection)}
                          onDelete={() =>
                            void onUpdateRemoteConnection(project.id, connection.id, null)
                          }
                        />
                      )
                    })}
                  </Stack>
                )}
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mt: 2.5 }}>
                  <Box sx={{ minWidth: 220 }}>
                    <Typography variant="caption" color="text.secondary">
                      默认连接
                    </Typography>
                    <Select
                      size="small"
                      fullWidth
                      displayEmpty
                      value={project.defaultRemoteConnectionId ?? ''}
                      disabled={busy || connections.length === 0}
                      onChange={(event) =>
                        void onUpdateRemoteDefaults(project.id, {
                          defaultRemoteConnectionId: event.target.value || null
                        })
                      }
                    >
                      <MenuItem value="">未设置</MenuItem>
                      {connections
                        .filter((connection) =>
                          hosts.some((host) => host.id === connection.hostProfileId)
                        )
                        .map((connection) => (
                          <MenuItem key={connection.id} value={connection.id}>
                            {connection.label}
                          </MenuItem>
                        ))}
                    </Select>
                  </Box>
                  <TextField
                    size="small"
                    fullWidth
                    label="远程工作目录"
                    disabled={busy}
                    value={workspaceRootDraft}
                    onChange={(event) =>
                      setWorkspaceRootDrafts((prev) => ({
                        ...prev,
                        [project.id]: event.target.value
                      }))
                    }
                    onBlur={() => {
                      const trimmed = workspaceRootDraft.trim()
                      if (trimmed === (project.remoteWorkspaceRoot ?? '')) return
                      void onUpdateRemoteDefaults(project.id, {
                        remoteWorkspaceRoot: trimmed || null
                      })
                    }}
                    placeholder="/cluster/lab/workspace"
                    sx={{ '& input': { fontFamily: 'var(--font-mono)' } }}
                  />
                </Stack>
              </Box>
            </Paper>
          )
        })
      )}

      <ConnectionDialog
        open={dialogProjectId !== null}
        draft={draft}
        hosts={hosts}
        busy={dialogBusy}
        error={dialogError}
        onChange={setDraft}
        onCancel={() => setDialogProjectId(null)}
        onSave={() => void saveConnection()}
        allowInputMapping={
          projects.find((project) => project.id === dialogProjectId)?.location.kind === 'local'
        }
      />
    </Stack>
  )
}

export default WrapperRemoteSettingsSection
