import { useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
import { Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'
import type { ProjectRemoteConnection, RemoteHostProfile } from '../../../types'
import {
  remoteConnectionDoctorTarget,
  remoteDoctorTargetKey,
  type RemoteDoctorTarget,
  type RemoteDoctorUiState
} from '../lib/remoteDoctorUi'
import { RemoteDoctorPanel } from './RemoteDoctorPanel'

const DeleteIcon = PhiIcons.action.delete
const EditIcon = PhiIcons.action.edit
const ServerIcon = PhiIcons.settings.remoteExecution

export function RemoteProjectConnectionRow({
  projectId,
  connection,
  host,
  remotePath,
  isDefault,
  busy,
  doctorState,
  onTest,
  onEdit,
  onDelete,
  onOpenRemoteSettings
}: {
  projectId: string
  connection: ProjectRemoteConnection
  host: RemoteHostProfile | undefined
  remotePath: string
  isDefault: boolean
  busy: boolean
  doctorState: RemoteDoctorUiState
  onTest: (target: RemoteDoctorTarget) => void
  onEdit: () => void
  onDelete: () => void
  onOpenRemoteSettings?: () => void
}): React.JSX.Element {
  useUiLanguage()
  const target = host
    ? remoteConnectionDoctorTarget(projectId, connection, host.hostAlias, remotePath)
    : null
  const targetKey = target ? remoteDoctorTargetKey(target) : ''
  const showing = doctorState.phase !== 'idle' && doctorState.key === targetKey

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
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
            {host?.hostAlias ?? remoteSetupCopy.sshReconfigurationRequired}
          </Typography>
        </Box>
        {isDefault && (
          <Chip size="small" label={remoteSetupCopy.default} color="primary" variant="outlined" />
        )}
        <Tooltip
          title={
            !host
              ? remoteSetupCopy.reconfigureSshFirst
              : !remotePath.trim()
                ? remoteSetupCopy.remoteDirectoryRequired
                : remoteSetupCopy.checkDirectoryAndEnvironment
          }
        >
          <span>
            <Button
              size="small"
              variant="outlined"
              disabled={busy || !target || !remotePath.trim() || doctorState.phase === 'running'}
              onClick={() => {
                if (target) onTest(target)
              }}
            >
              {showing && doctorState.phase === 'running'
                ? remoteSetupCopy.testing
                : showing
                  ? remoteSetupCopy.retest
                  : remoteSetupCopy.testConnection}
            </Button>
          </span>
        </Tooltip>
        {!host && onOpenRemoteSettings ? (
          <Button size="small" onClick={onOpenRemoteSettings}>
            {remoteSetupCopy.remoteSettings}
          </Button>
        ) : null}
        <Tooltip title={remoteSetupCopy.edit}>
          <span>
            <IconButton
              size="small"
              aria-label={remoteSetupCopy.editItem(connection.label)}
              disabled={busy || doctorState.phase === 'running'}
              onClick={onEdit}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={remoteSetupCopy.delete}>
          <span>
            <IconButton
              size="small"
              aria-label={remoteSetupCopy.deleteItem(connection.label)}
              disabled={busy || doctorState.phase === 'running'}
              onClick={onDelete}
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {connection.inputPathMapping && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', ml: 4, overflowWrap: 'anywhere' }}
        >
          {remoteSetupCopy.inputMappingPrefix}
          {connection.inputPathMapping.localRoot} → {connection.inputPathMapping.remoteRoot}
        </Typography>
      )}
      {target && (
        <RemoteDoctorPanel
          state={doctorState}
          targetKey={targetKey}
          onOpenRemoteSettings={onOpenRemoteSettings}
        />
      )}
    </Box>
  )
}
