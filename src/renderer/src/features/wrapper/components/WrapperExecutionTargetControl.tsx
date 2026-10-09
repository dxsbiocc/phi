import { Button, Stack, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'
import type { Project } from '../../../types'
import { useWrapperExecutionTargetController } from '../hooks/useWrapperExecutionTargetController'
import { RemoteNextflowInstallDialog } from './RemoteNextflowInstallDialog'
import { WrapperExecutionTargetDialog } from './WrapperExecutionTargetDialog'

const ServerIcon = PhiIcons.settings.remoteExecution

interface Props {
  project: Project
  busy?: boolean
  compact?: boolean
  onUpdateRemoteConnection?: Parameters<
    typeof useWrapperExecutionTargetController
  >[0]['onUpdateRemoteConnection']
  onUpdateRemoteDefaults?: Parameters<
    typeof useWrapperExecutionTargetController
  >[0]['onUpdateRemoteDefaults']
  onOpenRemoteSettings?: () => void
  onSaved?: () => void
}

function Trigger({
  busy,
  compact,
  configuredLabel,
  isRemoteProject,
  onOpen
}: {
  busy: boolean
  compact: boolean
  configuredLabel?: string
  isRemoteProject: boolean
  onOpen: () => void
}): React.JSX.Element {
  const label = isRemoteProject
    ? 'Wrapper 运行方式'
    : configuredLabel
      ? compact
        ? `服务器：${configuredLabel}`
        : `远程计算：${configuredLabel}`
      : compact
        ? '选择服务器'
        : '设置远程计算'
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Button
        size="small"
        variant="outlined"
        startIcon={<ServerIcon fontSize="small" />}
        disabled={busy}
        onClick={onOpen}
      >
        {label}
      </Button>
      {!compact && (
        <Typography variant="caption" color="text.secondary">
          {isRemoteProject
            ? 'Wrapper 自动在本项目服务器运行；这里可设置 Slurm 和软件环境。'
            : '本地项目仍默认在本机运行；仅在要求服务器运行时使用此目标。'}
        </Typography>
      )}
    </Stack>
  )
}

/** Local projects opt into server compute; SSH projects only configure how their bound server runs Wrappers. */
export function WrapperExecutionTargetControl({
  project,
  busy = false,
  compact = false,
  ...callbacks
}: Props): React.JSX.Element {
  const controller = useWrapperExecutionTargetController({ project, ...callbacks })
  return (
    <>
      <Trigger
        busy={busy}
        compact={compact}
        configuredLabel={controller.configured?.label}
        isRemoteProject={controller.isRemoteProject}
        onOpen={controller.openDialog}
      />
      <WrapperExecutionTargetDialog model={controller.model} actions={controller.actions} />
      <RemoteNextflowInstallDialog
        open={controller.installConfirmOpen}
        installing={controller.installing}
        onClose={controller.closeInstall}
        onConfirm={controller.confirmInstall}
      />
    </>
  )
}
