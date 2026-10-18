import { useUiLanguage } from '../../../lib/i18n'
import { remoteSetupCopy } from '../lib/remoteSetupCopy'
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
  useUiLanguage()
  const label = isRemoteProject
    ? remoteSetupCopy.wrapperExecutionMode
    : configuredLabel
      ? compact
        ? remoteSetupCopy.serverTarget(configuredLabel)
        : remoteSetupCopy.remoteTarget(configuredLabel)
      : compact
        ? remoteSetupCopy.selectServer
        : remoteSetupCopy.configureRemoteExecution
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
            ? remoteSetupCopy.remoteProjectExecutionHelp
            : remoteSetupCopy.localProjectExecutionHelp}
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
  useUiLanguage()
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
