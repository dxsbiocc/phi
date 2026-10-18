import { projectCopy } from '../lib/projectCopy'
import { useUiLanguage } from '../../../lib/i18n'
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
  useUiLanguage()
  return (
    <Stack spacing={1.5}>
      <TextField
        select
        fullWidth
        label={projectCopy.sSHServer}
        value={hostProfileId}
        onChange={(event) => onHostChange(event.target.value)}
        helperText={
          hostsLoading ? projectCopy.loadingServers : projectCopy.chooseAHostFromSshConfig
        }
      >
        <MenuItem value="">{projectCopy.chooseAServer}</MenuItem>
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
        {projectCopy.manageServers}
      </Button>
      {hostsError && <Alert severity="error">{hostsError}</Alert>}
      {!hostsLoading && !hostsError && hosts.length === 0 && (
        <Alert severity="info">{projectCopy.noSSHHostsFoundAddOneManuallyInRemoteSettings}</Alert>
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
