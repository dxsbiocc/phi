import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'

export function McpApiKeyDialog({
  connector,
  value,
  verified,
  installed,
  busy,
  error,
  onChange,
  onClose,
  onSubmit
}: {
  connector: FeaturedMcpConnector | null
  value: string
  verified: boolean
  installed: boolean
  busy: boolean
  error: string | null
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  useUiLanguage()

  const name = connector?.name ?? ''
  const canUseSavedKey = verified && !installed
  const canSubmit = Boolean(value.trim()) || canUseSavedKey

  return (
    <Dialog open={Boolean(connector)} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {installed
          ? verified
            ? connectorCopy.updateNamedKey(name)
            : connectorCopy.verifyNamedKey(name)
          : connectorCopy.addNamed(name)}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {connectorCopy.apiKeyIntro(name)}
          </Typography>
          {connector?.apiKey && (
            <Button
              component="a"
              href={connector.apiKey.obtainUrl}
              target="_blank"
              rel="noreferrer"
              size="small"
              sx={{ alignSelf: 'flex-start', pl: 0 }}
            >
              {connectorCopy.obtainKey(name)}
            </Button>
          )}
          {connector?.id === 'serpapi' && (
            <Alert severity="info">{connectorCopy.serpApiDisclosure}</Alert>
          )}
          <TextField
            autoFocus
            fullWidth
            type="password"
            label={connectorCopy.apiKeyLabel}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit && !busy) onSubmit()
            }}
          />
          {canUseSavedKey && !value && (
            <Typography variant="body2" color="text.secondary">
              {connectorCopy.existingKeyHint}
            </Typography>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button disabled={busy} onClick={onClose}>
          {resourceUi.cancel}
        </Button>
        <Button variant="contained" disabled={busy || !canSubmit} onClick={onSubmit}>
          {busy
            ? connectorCopy.verifying
            : value.trim()
              ? installed
                ? verified
                  ? connectorCopy.verifyUpdate
                  : connectorCopy.verifySave
                : connectorCopy.verifyAdd
              : connectorCopy.addConnector}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
