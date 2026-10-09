import { Alert, Button, MenuItem, Stack, TextField } from '@mui/material'

import type { RemoteHostProfile } from '../../../types'
import { RemoteDirectoryTree } from './RemoteDirectoryTree'

function remoteHostLabel(host: RemoteHostProfile): string {
  const label = host.label.trim()
  const alias = host.hostAlias.trim()
  return label === alias ? label : `${label} · ${alias}`
}

export function RemoteProjectFields({
  hosts,
  hostsLoading,
  hostsError,
  hostProfileId,
  remoteRoot,
  onHostChange,
  onRemoteRootChange,
  onOpenRemoteSettings
}: {
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
    <Stack spacing={1.5}>
      <TextField
        select
        fullWidth
        label="SSH 服务器"
        value={hostProfileId}
        onChange={(event) => onHostChange(event.target.value)}
        helperText={hostsLoading ? '正在读取服务器…' : '可直接选择 ~/.ssh/config 中的主机'}
      >
        <MenuItem value="">请选择服务器</MenuItem>
        {hosts.map((host) => (
          <MenuItem key={host.id} value={host.id}>
            {remoteHostLabel(host)}
          </MenuItem>
        ))}
      </TextField>
      <Button
        variant="text"
        size="small"
        onClick={onOpenRemoteSettings}
        sx={{ alignSelf: 'flex-start' }}
      >
        管理服务器
      </Button>
      {hostsError && <Alert severity="error">{hostsError}</Alert>}
      {!hostsLoading && !hostsError && hosts.length === 0 && (
        <Alert severity="info">未识别到 SSH 主机；可在远程设置中手动添加。</Alert>
      )}
      {hostProfileId ? (
        <RemoteDirectoryTree
          key={hostProfileId}
          hostProfileId={hostProfileId}
          selectedPath={remoteRoot}
          onSelectPath={onRemoteRootChange}
        />
      ) : null}
    </Stack>
  )
}
