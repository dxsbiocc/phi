import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import type { RemoteProjectCreateInput } from '../../../../shared/projectLocation'
import { PERMISSION_MODE_ICON_META } from '../../icons'
import type { PermissionMode, RemoteHostProfile } from '../../types'
import { canSubmitNewProject, submitNewProjectDraft } from './lib/projectCreateUi'
import { ProjectLocationFields } from './components/ProjectLocationFields'

const AskPermissionIcon = PERMISSION_MODE_ICON_META.ask.Icon
const AutoPermissionIcon = PERMISSION_MODE_ICON_META.auto.Icon
const FullPermissionIcon = PERMISSION_MODE_ICON_META.full.Icon

type NewProjectDialogProps = {
  open: boolean
  onClose: () => void
  onPickDirectory: () => Promise<string | null>
  onCreate: (
    name: string,
    workingDirectory: string,
    permissionMode: PermissionMode
  ) => Promise<void>
  onCreateRemote: (input: RemoteProjectCreateInput) => Promise<void>
  onOpenRemoteSettings: () => void
}

function NewProjectDialog({
  open,
  onClose,
  onPickDirectory,
  onCreate,
  onCreateRemote,
  onOpenRemoteSettings
}: NewProjectDialogProps): React.JSX.Element {
  const [locationMode, setLocationMode] = useState<'local' | 'ssh'>('local')
  const [name, setName] = useState('')
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [hostProfileId, setHostProfileId] = useState('')
  const [remoteRoot, setRemoteRoot] = useState('')
  const [hosts, setHosts] = useState<RemoteHostProfile[]>([])
  const [hostsLoading, setHostsLoading] = useState(false)
  const [hostsError, setHostsError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    if (!open || locationMode !== 'ssh') return
    let cancelled = false
    window.api
      .listRemoteHosts()
      .then((items) => {
        if (cancelled) return
        setHosts(items)
        setHostProfileId((current) => (items.some((item) => item.id === current) ? current : ''))
      })
      .catch(() => {
        if (!cancelled) setHostsError('无法读取服务器列表，请关闭后重试。')
      })
      .finally(() => {
        if (!cancelled) setHostsLoading(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [open, locationMode])

  const reset = (): void => {
    setLocationMode('local')
    setName('')
    setWorkingDirectory('')
    setHostProfileId('')
    setRemoteRoot('')
    setCreateError(null)
    setPermissionMode('ask')
  }

  const handlePickDirectory = async (): Promise<void> => {
    const picked = await onPickDirectory()
    if (picked) {
      setWorkingDirectory(picked)
      if (!name.trim()) {
        setName(picked.split('/').filter(Boolean).pop() ?? picked)
      }
    }
  }

  const handleCreate = async (): Promise<void> => {
    if (isCreating) return
    const draft = {
      locationMode,
      name,
      workingDirectory,
      hostProfileId,
      remoteRoot,
      permissionMode
    }
    if (!canSubmitNewProject(draft)) return
    setIsCreating(true)
    setCreateError(null)
    try {
      await submitNewProjectDraft(draft, {
        createLocal: onCreate,
        createRemote: onCreateRemote
      })
      reset()
      onClose()
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '创建项目失败，请重试。')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (isCreating) return
        reset()
        onClose()
      }}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>新建项目</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="项目名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            fullWidth
          />
          <ProjectLocationFields
            mode={locationMode}
            onModeChange={(next) => {
              setLocationMode(next)
              setCreateError(null)
              if (next === 'ssh') {
                setHostsLoading(true)
                setHostsError(null)
              }
            }}
            workingDirectory={workingDirectory}
            onPickDirectory={() => void handlePickDirectory()}
            hosts={hosts}
            hostsLoading={hostsLoading}
            hostsError={hostsError}
            hostProfileId={hostProfileId}
            remoteRoot={remoteRoot}
            onHostChange={(id) => {
              setHostProfileId(id)
              setRemoteRoot('')
            }}
            onRemoteRootChange={setRemoteRoot}
            onOpenRemoteSettings={() => {
              setCreateError(null)
              onOpenRemoteSettings()
            }}
          />

          <Stack spacing={1}>
            <Typography variant="body2">权限审批</Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              value={permissionMode}
              onChange={(_, next: PermissionMode | null) => {
                if (next) setPermissionMode(next)
              }}
            >
              <ToggleButton value="ask" sx={{ minHeight: 44 }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <AskPermissionIcon
                    fontSize="small"
                    sx={{ color: PERMISSION_MODE_ICON_META.ask.color }}
                  />
                  <span>重要操作前询问</span>
                </Stack>
              </ToggleButton>
              <ToggleButton
                value="auto"
                sx={{
                  minHeight: 44,
                  color: 'warning.main',
                  '&.Mui-selected': { color: 'warning.main' }
                }}
              >
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <AutoPermissionIcon
                    fontSize="small"
                    sx={{ color: PERMISSION_MODE_ICON_META.auto.color }}
                  />
                  <span>帮我批准</span>
                </Stack>
              </ToggleButton>
              <ToggleButton value="full" sx={{ minHeight: 44, color: 'error.main' }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <FullPermissionIcon
                    fontSize="small"
                    sx={{ color: PERMISSION_MODE_ICON_META.full.color }}
                  />
                  <span>完全访问权限</span>
                </Stack>
              </ToggleButton>
            </ToggleButtonGroup>
            <Typography
              variant="caption"
              color={permissionMode === 'full' ? 'error.main' : 'text.secondary'}
            >
              {permissionMode === 'ask'
                ? '执行命令、写入或修改文件前会先向你确认。'
                : permissionMode === 'auto'
                  ? '自动执行允许的工具，不会逐次确认。'
                  : locationMode === 'ssh'
                    ? '可在所选服务器上访问当前账号有权限的文件并执行命令。'
                    : '可不受限制地访问互联网和你电脑上的任何文件。'}
            </Typography>
          </Stack>
          {createError && <Alert severity="error">{createError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          onClick={() => {
            reset()
            onClose()
          }}
          sx={{ minHeight: 44 }}
        >
          取消
        </Button>
        <Button
          variant="contained"
          disabled={
            isCreating ||
            !canSubmitNewProject({
              locationMode,
              name,
              workingDirectory,
              hostProfileId,
              remoteRoot,
              permissionMode
            })
          }
          onClick={() => void handleCreate()}
          sx={{ minHeight: 44 }}
        >
          {isCreating ? <CircularProgress size={18} color="inherit" /> : '创建'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default NewProjectDialog
