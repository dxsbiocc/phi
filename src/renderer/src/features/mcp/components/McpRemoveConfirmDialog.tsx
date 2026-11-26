import {
  Button,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'

export interface McpRemoveConfirmTarget {
  id: string
  name: string
  clearsAuth?: boolean
  clearsEnvironment?: boolean
  location?: string
}

export function McpRemoveConfirmDialog({
  target,
  onCancel,
  onConfirm
}: {
  target: McpRemoveConfirmTarget | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  useUiLanguage()

  return (
    <ConfirmationDialog open={target !== null} onClose={onCancel} data-phi-mcp-remove-dialog="true">
      <DialogTitle>{target ? connectorCopy.removeConnectorTitle(target.name) : ''}</DialogTitle>
      <DialogContent>
        {target ? (
          <Stack spacing={1.25}>
            <DialogContentText>{connectorCopy.removeConnectorDescription}</DialogContentText>
            {target.clearsAuth ? (
              <Typography variant="body2" color="text.secondary">
                • {connectorCopy.removeConnectorAuthNotice}
              </Typography>
            ) : null}
            {target.clearsEnvironment ? (
              <Typography variant="body2" color="text.secondary">
                • {connectorCopy.removeConnectorEnvNotice}
              </Typography>
            ) : null}
            <Typography variant="caption" color="text.secondary">
              {connectorCopy.removeBackgroundHint}
            </Typography>
            {target.location ? (
              <Typography
                component="code"
                variant="caption"
                sx={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
              >
                {target.location}
              </Typography>
            ) : null}
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{resourceUi.cancel}</Button>
        <Button color="error" variant="contained" onClick={onConfirm}>
          {connectorCopy.confirmRemoveConnector}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
