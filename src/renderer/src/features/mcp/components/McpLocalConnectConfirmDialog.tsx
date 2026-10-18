import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import type {
  LocalMcpConnectorRequest,
  LocalMcpRuntimeOption
} from '../../../../../shared/mcpConnectorCatalog'

export interface McpLocalConnectConfirmDialogProps {
  open: boolean
  submitting: boolean
  request: LocalMcpConnectorRequest
  runtimes: readonly LocalMcpRuntimeOption[]
  disablePortal?: boolean
  onCancel: () => void
  onConfirm: () => void
}

function runtimeLabel(
  request: LocalMcpConnectorRequest,
  runtimes: readonly LocalMcpRuntimeOption[]
): string {
  if (request.runtime.kind === 'bun') return connectorCopy.bundledBun
  if (request.runtime.kind === 'host') return connectorCopy.hostRuntime
  const runtimeRef = request.runtime.ref
  return runtimes.find((runtime) => runtime.ref === runtimeRef)?.label ?? runtimeRef
}

function connectorArgv(request: LocalMcpConnectorRequest): string[] {
  return request.runtime.kind === 'bun'
    ? ['bun', request.command, ...request.args]
    : [request.command, ...request.args]
}

export function McpLocalConnectConfirmDialog({
  open,
  submitting,
  request,
  runtimes,
  disablePortal = false,
  onCancel,
  onConfirm
}: McpLocalConnectConfirmDialogProps): React.JSX.Element {
  useUiLanguage()

  const argv = connectorArgv(request)
  const environmentNames = Object.keys(request.env)

  return (
    <ConfirmationDialog
      open={open}
      onClose={submitting ? undefined : onCancel}
      disablePortal={disablePortal}
      aria-labelledby="mcp-local-connect-confirm-title"
      aria-describedby="mcp-local-connect-confirm-description"
    >
      <DialogTitle id="mcp-local-connect-confirm-title">
        {connectorCopy.confirmLocalAdd}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Stack spacing={0.5}>
            <Typography variant="subtitle2">{connectorCopy.runtimeLocation}</Typography>
            <Typography>{runtimeLabel(request, runtimes)}</Typography>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="subtitle2">{connectorCopy.launchArguments}</Typography>
            {argv.map((arg, index) => (
              <Typography
                key={`${index}:${arg}`}
                component="code"
                sx={{ overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}
              >
                argv[{index}] = {JSON.stringify(arg)}
              </Typography>
            ))}
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="subtitle2">{connectorCopy.environmentVariables}</Typography>
            <Typography sx={{ overflowWrap: 'anywhere' }}>
              {environmentNames.length > 0 ? environmentNames.join(', ') : connectorCopy.none}
            </Typography>
          </Stack>
          {request.cwd ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">{connectorCopy.workingDirectory}</Typography>
              <Typography component="code" sx={{ overflowWrap: 'anywhere' }}>
                {request.cwd}
              </Typography>
            </Stack>
          ) : null}
          {request.runtime.kind === 'host' ? (
            <Alert severity="warning">{connectorCopy.hostWarning}</Alert>
          ) : null}
          {request.runtime.kind === 'bun' ? (
            <Alert severity="warning">{connectorCopy.bunWarning}</Alert>
          ) : null}
          <Typography id="mcp-local-connect-confirm-description" color="text.secondary">
            {connectorCopy.backgroundStartHint}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={submitting} onClick={onCancel}>
          {resourceUi.cancel}
        </Button>
        <Button variant="contained" disabled={submitting} onClick={onConfirm}>
          {submitting ? connectorCopy.submitting : connectorCopy.confirmBackgroundAdd}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
