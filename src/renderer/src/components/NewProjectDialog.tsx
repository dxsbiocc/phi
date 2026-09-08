import { useState } from 'react'
import {
  Button,
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
import { PERMISSION_MODE_ICON_META, PhiIcons } from '../icons'
import type { PermissionMode } from '../types'

const FolderOpenIcon = PhiIcons.entity.project
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
}

function NewProjectDialog({
  open,
  onClose,
  onPickDirectory,
  onCreate
}: NewProjectDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [isCreating, setIsCreating] = useState(false)

  const reset = (): void => {
    setName('')
    setWorkingDirectory('')
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
    if (!workingDirectory) return
    setIsCreating(true)
    try {
      await onCreate(name, workingDirectory, permissionMode)
      reset()
      onClose()
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>新建项目</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            项目会记住一个工作目录，让助手可以读写其中的文件；临时对话没有这个限制，也不需要选择目录。
          </Typography>

          <TextField
            label="项目名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            fullWidth
          />

          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField
              label="工作目录"
              value={workingDirectory}
              placeholder="点击右侧按钮选择文件夹"
              fullWidth
              slotProps={{ input: { readOnly: true } }}
            />
            <Button
              variant="outlined"
              startIcon={<FolderOpenIcon />}
              onClick={() => void handlePickDirectory()}
              sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
            >
              选择文件夹
            </Button>
          </Stack>

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
                  <AskPermissionIcon fontSize="small" />
                  <span>重要操作前询问</span>
                </Stack>
              </ToggleButton>
              <ToggleButton value="auto" sx={{ minHeight: 44 }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <AutoPermissionIcon fontSize="small" />
                  <span>帮我批准</span>
                </Stack>
              </ToggleButton>
              <ToggleButton value="full" sx={{ minHeight: 44, color: 'error.main' }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <FullPermissionIcon fontSize="small" />
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
                  : '可不受限制地访问互联网和你电脑上的任何文件。'}
            </Typography>
          </Stack>
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
          disabled={!workingDirectory || isCreating}
          onClick={() => void handleCreate()}
          sx={{ minHeight: 44 }}
        >
          创建
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default NewProjectDialog
