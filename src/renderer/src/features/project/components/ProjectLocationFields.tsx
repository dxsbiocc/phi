import {
  Button,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'

import { PhiIcons } from '../../../icons'
import type { RemoteHostProfile } from '../../../types'
import { RemoteProjectFields } from './RemoteProjectFields'

const FolderOpenIcon = PhiIcons.entity.project

export function ProjectLocationFields({
  mode,
  onModeChange,
  workingDirectory,
  onPickDirectory,
  hosts,
  hostsLoading,
  hostsError,
  hostProfileId,
  remoteRoot,
  onHostChange,
  onRemoteRootChange,
  onOpenRemoteSettings
}: {
  mode: 'local' | 'ssh'
  onModeChange: (mode: 'local' | 'ssh') => void
  workingDirectory: string
  onPickDirectory: () => void
  hosts: RemoteHostProfile[]
  hostsLoading: boolean
  hostsError: string | null
  hostProfileId: string
  remoteRoot: string
  onHostChange: (id: string) => void
  onRemoteRootChange: (path: string) => void
  onOpenRemoteSettings: () => void
}): React.JSX.Element {
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {mode === 'local'
          ? '项目会记住一个本机工作目录；临时对话不需要选择目录。'
          : '远程项目会记住所选服务器上的目录；对话中的项目文件和命令操作将在该服务器执行。'}
      </Typography>
      <ToggleButtonGroup
        exclusive
        fullWidth
        value={mode}
        onChange={(_, next: 'local' | 'ssh' | null) => {
          if (next) onModeChange(next)
        }}
      >
        <ToggleButton value="local">本机文件夹</ToggleButton>
        <ToggleButton value="ssh">远程服务器</ToggleButton>
      </ToggleButtonGroup>
      {mode === 'local' ? (
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
            onClick={onPickDirectory}
            sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
          >
            选择文件夹
          </Button>
        </Stack>
      ) : (
        <RemoteProjectFields
          hosts={hosts}
          hostsLoading={hostsLoading}
          hostsError={hostsError}
          hostProfileId={hostProfileId}
          remoteRoot={remoteRoot}
          onHostChange={onHostChange}
          onRemoteRootChange={onRemoteRootChange}
          onOpenRemoteSettings={onOpenRemoteSettings}
        />
      )}
    </Stack>
  )
}
