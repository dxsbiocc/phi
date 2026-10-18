import { projectCopy } from '../lib/projectCopy'
import { useUiLanguage } from '../../../lib/i18n'
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
  useUiLanguage()
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {mode === 'local'
          ? projectCopy.projectsRememberALocalWorkingDirectoryTemporaryConversationsDoNot
          : projectCopy.remoteProjectsRememberADirectoryOnTheSelectedServerProject}
      </Typography>
      <ToggleButtonGroup
        exclusive
        fullWidth
        value={mode}
        onChange={(_, next: 'local' | 'ssh' | null) => {
          if (next) onModeChange(next)
        }}
      >
        <ToggleButton value="local">{projectCopy.localFolder}</ToggleButton>
        <ToggleButton value="ssh">{projectCopy.remoteServer}</ToggleButton>
      </ToggleButtonGroup>
      {mode === 'local' ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <TextField
            label={projectCopy.workingDirectory}
            value={workingDirectory}
            placeholder={projectCopy.useTheButtonOnTheRightToChooseAFolder}
            fullWidth
            slotProps={{ input: { readOnly: true } }}
          />
          <Button
            variant="outlined"
            startIcon={<FolderOpenIcon />}
            onClick={onPickDirectory}
            sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
          >
            {projectCopy.chooseFolder}
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
