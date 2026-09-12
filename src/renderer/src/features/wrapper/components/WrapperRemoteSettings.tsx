import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../../icons'
import type { Project, ProjectRemoteConnection } from '../../../types'

const AddIcon = PhiIcons.action.add
const DeleteIcon = PhiIcons.action.delete
const EditIcon = PhiIcons.action.edit
const ServerIcon = PhiIcons.settings.remoteExecution

/**
 * Local draft state for the add/edit dialog — mirrors `ProjectRemoteConnection`
 * plus the passphrase bookkeeping that field doesn't carry (the record only
 * ever stores `hasPassphrase`, never the passphrase itself — see
 * `remote-credential-store.ts`).
 */
interface ConnectionDraft {
  id: string
  label: string
  host: string
  port: string
  username: string
  privateKeyPath: string
  needsPassphrase: boolean
  /** Empty means "leave the stored passphrase untouched" when editing a connection that already had one. */
  passphraseInput: string
}

const EMPTY_DRAFT: ConnectionDraft = {
  id: '',
  label: '',
  host: '',
  port: '',
  username: '',
  privateKeyPath: '',
  needsPassphrase: false,
  passphraseInput: ''
}

function draftFromConnection(connection: ProjectRemoteConnection): ConnectionDraft {
  return {
    id: connection.id,
    label: connection.label,
    host: connection.host,
    port: connection.port ? String(connection.port) : '',
    username: connection.username,
    privateKeyPath: connection.privateKeyPath,
    needsPassphrase: !!connection.hasPassphrase,
    passphraseInput: ''
  }
}

function draftValidationError(
  draft: ConnectionDraft,
  wasPassphraseAlreadyStored: boolean
): string | null {
  if (!draft.label.trim()) return '请填写连接名称'
  if (!draft.host.trim()) return '请填写主机地址'
  if (!draft.username.trim()) return '请填写用户名'
  if (!draft.privateKeyPath.trim()) return '请选择 SSH 私钥文件'
  if (draft.port && !/^\d+$/.test(draft.port)) return '端口必须是数字'
  if (draft.needsPassphrase && !draft.passphraseInput && !wasPassphraseAlreadyStored) {
    return '已开启口令保护，请输入密钥口令'
  }
  return null
}

interface ConnectionDialogProps {
  open: boolean
  draft: ConnectionDraft
  isNew: boolean
  wasPassphraseAlreadyStored: boolean
  credentialStorageAvailable: boolean | null
  busy: boolean
  error: string | null
  onChange: (next: ConnectionDraft) => void
  onPickKeyFile: () => void
  onCancel: () => void
  onSave: () => void
}

function ConnectionDialog({
  open,
  draft,
  isNew,
  wasPassphraseAlreadyStored,
  credentialStorageAvailable,
  busy,
  error,
  onChange,
  onPickKeyFile,
  onCancel,
  onSave
}: ConnectionDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>{isNew ? '添加远程连接' : '编辑远程连接'}</DialogTitle>
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
          <Stack direction="row" spacing={1.5}>
            <TextField
              label="主机地址"
              size="small"
              fullWidth
              value={draft.host}
              onChange={(event) => onChange({ ...draft, host: event.target.value })}
              placeholder="lab-hpc.example.edu"
            />
            <TextField
              label="端口"
              size="small"
              sx={{ width: 96 }}
              value={draft.port}
              onChange={(event) => onChange({ ...draft, port: event.target.value })}
              placeholder="22"
            />
          </Stack>
          <TextField
            label="用户名"
            size="small"
            fullWidth
            value={draft.username}
            onChange={(event) => onChange({ ...draft, username: event.target.value })}
          />
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              SSH 私钥文件
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                fullWidth
                value={draft.privateKeyPath}
                slotProps={{ input: { readOnly: true } }}
                placeholder="~/.ssh/id_ed25519"
                sx={{ '& input': { fontFamily: 'var(--font-mono)', fontSize: '0.8rem' } }}
              />
              <Button
                variant="outlined"
                size="small"
                onClick={onPickKeyFile}
                sx={{ flexShrink: 0 }}
              >
                浏览…
              </Button>
            </Stack>
          </Box>

          <Divider />

          <FormControlLabel
            control={
              <Switch
                checked={draft.needsPassphrase}
                disabled={credentialStorageAvailable === false}
                onChange={(event) =>
                  onChange({ ...draft, needsPassphrase: event.target.checked, passphraseInput: '' })
                }
              />
            }
            label="私钥需要口令"
          />
          {credentialStorageAvailable === false && (
            <Alert severity="warning" variant="outlined">
              当前系统不支持加密存储密钥口令，请使用无口令的 SSH 密钥。
            </Alert>
          )}
          {draft.needsPassphrase && credentialStorageAvailable !== false && (
            <TextField
              label="密钥口令"
              type="password"
              size="small"
              fullWidth
              value={draft.passphraseInput}
              onChange={(event) => onChange({ ...draft, passphraseInput: event.target.value })}
              placeholder={wasPassphraseAlreadyStored ? '留空则不修改已保存的口令' : ''}
              helperText="口令会通过系统密钥串加密保存，不会明文写入项目配置文件"
            />
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
    patch: ProjectRemoteConnection | null,
    passphrase?: string | null
  ) => Promise<void>
  onUpdateRemoteDefaults: (
    projectId: string,
    defaults: { defaultRemoteConnectionId?: string | null; remoteWorkspaceRoot?: string | null }
  ) => Promise<void>
}

/**
 * Project-scoped SSH/Slurm remote execution settings — the UI surface for
 * `projects.ts`'s `remoteConnections`/`defaultRemoteConnectionId`/
 * `remoteWorkspaceRoot`, which until now only existed as functions callable
 * from code/tests. See docs/design/phi-wrapper-technical-design.md's
 * "Project state stores references" — this is where a user actually fills
 * those references in, rather than an agent or a test doing it for them.
 */
export function WrapperRemoteSettingsSection({
  projects,
  updatingProjectId,
  onUpdateRemoteConnection,
  onUpdateRemoteDefaults
}: WrapperRemoteSettingsProps): React.JSX.Element {
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_DRAFT)
  const [wasPassphraseAlreadyStored, setWasPassphraseAlreadyStored] = useState(false)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [credentialStorageAvailable, setCredentialStorageAvailable] = useState<boolean | null>(null)
  const [workspaceRootDrafts, setWorkspaceRootDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    if (dialogProjectId === null) return
    let cancelled = false
    window.api
      .isRemoteCredentialStorageAvailable()
      .then((available) => {
        if (!cancelled) setCredentialStorageAvailable(available)
      })
      .catch(() => {
        if (!cancelled) setCredentialStorageAvailable(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [dialogProjectId])

  function openAddDialog(projectId: string): void {
    setDialogProjectId(projectId)
    setDraft(EMPTY_DRAFT)
    setWasPassphraseAlreadyStored(false)
    setDialogError(null)
  }

  function openEditDialog(projectId: string, connection: ProjectRemoteConnection): void {
    setDialogProjectId(projectId)
    setDraft(draftFromConnection(connection))
    setWasPassphraseAlreadyStored(!!connection.hasPassphrase)
    setDialogError(null)
  }

  function closeDialog(): void {
    setDialogProjectId(null)
    setDialogError(null)
  }

  async function handlePickKeyFile(): Promise<void> {
    const path = await window.api.pickPrivateKeyFile()
    if (path) setDraft((prev) => ({ ...prev, privateKeyPath: path }))
  }

  async function handleSaveConnection(): Promise<void> {
    if (!dialogProjectId) return
    const validationError = draftValidationError(draft, wasPassphraseAlreadyStored)
    if (validationError) {
      setDialogError(validationError)
      return
    }

    const isNew = !draft.id
    const connectionId = isNew ? crypto.randomUUID() : draft.id
    const patch: ProjectRemoteConnection = {
      id: connectionId,
      label: draft.label.trim(),
      host: draft.host.trim(),
      port: draft.port ? Number(draft.port) : undefined,
      username: draft.username.trim(),
      privateKeyPath: draft.privateKeyPath.trim(),
      hasPassphrase: draft.needsPassphrase || undefined
    }
    const passphrase = !draft.needsPassphrase
      ? null
      : draft.passphraseInput
        ? draft.passphraseInput
        : undefined

    setDialogBusy(true)
    setDialogError(null)
    try {
      await onUpdateRemoteConnection(dialogProjectId, connectionId, patch, passphrase)
      closeDialog()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }

  function handleRemoveConnection(projectId: string, connectionId: string): void {
    void onUpdateRemoteConnection(projectId, connectionId, null, null)
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">远程执行</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760 }}>
          配置项目提交 wrapper 到远程 Slurm 集群时使用的 SSH
          连接与远程工作目录。私钥文件保留在磁盘原位，Phi
          不会复制密钥内容；口令通过系统密钥串加密保存。
        </Typography>
      </Box>

      {projects.length === 0 ? (
        <Alert severity="info" variant="outlined">
          还没有项目
        </Alert>
      ) : (
        <Stack spacing={2}>
          {projects.map((project) => {
            const connections = project.remoteConnections ?? []
            const busy = updatingProjectId === project.id
            const workspaceRootDraft =
              workspaceRootDrafts[project.id] ?? project.remoteWorkspaceRoot ?? ''

            return (
              <Paper
                key={project.id}
                variant="outlined"
                sx={{ borderRadius: 1, overflow: 'hidden' }}
              >
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
                      disabled={busy}
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
                      {connections.map((connection) => (
                        <Stack
                          key={connection.id}
                          direction="row"
                          spacing={1}
                          sx={{ alignItems: 'center' }}
                        >
                          <ServerIcon fontSize="small" color="action" />
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {connection.label}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ fontFamily: 'var(--font-mono)' }}
                            >
                              {connection.username}@{connection.host}
                              {connection.port ? `:${connection.port}` : ''}
                            </Typography>
                          </Box>
                          {connection.id === project.defaultRemoteConnectionId && (
                            <Chip size="small" label="默认" color="primary" variant="outlined" />
                          )}
                          {connection.hasPassphrase && (
                            <Tooltip title="私钥需要口令">
                              <Chip size="small" label="已加锁" variant="outlined" />
                            </Tooltip>
                          )}
                          <Tooltip title="编辑">
                            <span>
                              <IconButton
                                size="small"
                                disabled={busy}
                                onClick={() => openEditDialog(project.id, connection)}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="删除">
                            <span>
                              <IconButton
                                size="small"
                                disabled={busy}
                                onClick={() => handleRemoveConnection(project.id, connection.id)}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      ))}
                    </Stack>
                  )}

                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: 'minmax(220px, 320px) 1fr' },
                      gap: 1.5,
                      mt: 2.5
                    }}
                  >
                    <Box>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mb: 0.75 }}
                      >
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
                        {connections.map((connection) => (
                          <MenuItem key={connection.id} value={connection.id}>
                            {connection.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mb: 0.75 }}
                      >
                        远程工作目录
                      </Typography>
                      <TextField
                        size="small"
                        fullWidth
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
                        placeholder="/cluster/facility/<lab>/WorkSpace"
                        sx={{ '& input': { fontFamily: 'var(--font-mono)', fontSize: '0.82rem' } }}
                      />
                    </Box>
                  </Box>
                </Box>
              </Paper>
            )
          })}
        </Stack>
      )}

      <ConnectionDialog
        open={dialogProjectId !== null}
        draft={draft}
        isNew={!draft.id}
        wasPassphraseAlreadyStored={wasPassphraseAlreadyStored}
        credentialStorageAvailable={credentialStorageAvailable}
        busy={dialogBusy}
        error={dialogError}
        onChange={setDraft}
        onPickKeyFile={() => void handlePickKeyFile()}
        onCancel={closeDialog}
        onSave={() => void handleSaveConnection()}
      />
    </Stack>
  )
}

export default WrapperRemoteSettingsSection
