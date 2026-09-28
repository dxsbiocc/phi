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
  onDelete
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
}): React.JSX.Element {
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
            {host?.hostAlias ?? '需重新配置 SSH 服务器'}
          </Typography>
        </Box>
        {isDefault && <Chip size="small" label="默认" color="primary" variant="outlined" />}
        <Tooltip
          title={
            !host
              ? '先重新配置 SSH 服务器'
              : !remotePath.trim()
                ? '先填写远程工作目录'
                : '检查目录和运行环境'
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
                ? '测试中…'
                : showing
                  ? '重新测试'
                  : '测试连接'}
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="编辑">
          <span>
            <IconButton
              size="small"
              aria-label={`编辑 ${connection.label}`}
              disabled={busy || doctorState.phase === 'running'}
              onClick={onEdit}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="删除">
          <span>
            <IconButton
              size="small"
              aria-label={`删除 ${connection.label}`}
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
          输入映射：{connection.inputPathMapping.localRoot} →{' '}
          {connection.inputPathMapping.remoteRoot}
        </Typography>
      )}
      {target && <RemoteDoctorPanel state={doctorState} targetKey={targetKey} />}
    </Box>
  )
}
