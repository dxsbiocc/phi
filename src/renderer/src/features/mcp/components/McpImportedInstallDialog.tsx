import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { resourceSourceLabel } from '../../../lib/resourceUi'
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
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'

export function McpImportedInstallDialog({
  connector,
  open,
  busy = false,
  onCancel,
  onConfirm
}: {
  connector: FeaturedMcpConnector | null
  open: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  useUiLanguage()

  return (
    <ConfirmationDialog open={open} onClose={busy ? undefined : onCancel} disablePortal>
      <DialogTitle>{connectorCopy.confirmUnsignedInstall}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="warning">{connectorCopy.unsignedInstallHint}</Alert>
          {connector?.source && (
            <Typography color="text.secondary">
              {resourceSourceLabel(connector.source.label)} {connectorCopy.unsignedSuffix}
            </Typography>
          )}
          {connector?.transport === 'stdio' ? (
            <Stack spacing={1}>
              <Typography>
                {connectorCopy.command}:<code>{connector.command ?? ''}</code>
              </Typography>
              <Typography sx={{ overflowWrap: 'anywhere' }}>
                {connectorCopy.arguments}:<code>{JSON.stringify(connector.args ?? [])}</code>
              </Typography>
              <Typography sx={{ overflowWrap: 'anywhere' }}>
                {connectorCopy.environmentVariables}:<code>{connector.environment ?? ''}</code>
              </Typography>
            </Stack>
          ) : (
            <Typography sx={{ overflowWrap: 'anywhere' }}>
              URL:<code>{connector?.url ?? ''}</code>
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onCancel}>
          {resourceUi.cancel}
        </Button>
        <Button
          variant="contained"
          color="warning"
          disabled={busy || !connector}
          onClick={onConfirm}
        >
          {connectorCopy.confirmContinue}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
