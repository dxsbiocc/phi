import { useUiLanguage } from '../../../lib/i18n'
import { localizeRemoteSetupMessage, remoteSetupCopy } from '../lib/remoteSetupCopy'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography
} from '@mui/material'

export type RemoteHostAuthMode = 'passwordless' | 'existing-key'

export interface RemoteHostDraft {
  id: string
  label: string
  hostAlias: string
  hostname: string
  user: string
  port: string
  identityFile: string
  source: 'ssh-config' | 'phi'
  authMode?: RemoteHostAuthMode
}

function AuthenticationOption({
  value,
  selected,
  title,
  description,
  disabled
}: {
  value: RemoteHostAuthMode
  selected: boolean
  title: string
  description: string
  disabled?: boolean
}): React.JSX.Element {
  useUiLanguage()
  return (
    <FormControlLabel
      value={value}
      disabled={disabled}
      control={<Radio />}
      label={
        <Box sx={{ py: 0.25 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
            {description}
          </Typography>
        </Box>
      }
      sx={{
        m: 0,
        px: 1.25,
        py: 0.75,
        minHeight: 72,
        alignItems: 'flex-start',
        border: 1,
        borderColor: selected ? 'primary.main' : 'divider',
        borderRadius: 2,
        bgcolor: selected ? 'action.selected' : 'background.paper',
        transition: 'border-color 180ms ease, background-color 180ms ease',
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
        '& .MuiRadio-root': { mt: -0.25 },
        '& .MuiFormControlLabel-label': { flex: 1 }
      }}
    />
  )
}

export function RemoteHostDialog({
  open,
  draft,
  busy,
  error,
  onDraftChange,
  onClose,
  onSave,
  onPasswordBootstrap
}: {
  open: boolean
  draft: RemoteHostDraft
  busy: boolean
  error: string | null
  onDraftChange: (draft: RemoteHostDraft) => void
  onClose: () => void
  onSave: () => void
  onPasswordBootstrap?: () => void
}): React.JSX.Element {
  useUiLanguage()
  const legacy = draft.source === 'phi'
  const authMode: RemoteHostAuthMode =
    legacy || !onPasswordBootstrap ? 'existing-key' : (draft.authMode ?? 'passwordless')
  const configuringPasswordless = !legacy && authMode === 'passwordless' && onPasswordBootstrap
  const connectionReady = Boolean(draft.hostAlias.trim() && (legacy || draft.hostname.trim()))
  const passwordlessReady = connectionReady && Boolean(draft.user.trim())

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { borderRadius: 3 } } }}
    >
      <DialogTitle component="div" sx={{ px: 3, pt: 3, pb: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 750 }}>
          {draft.id ? remoteSetupCopy.editServer : remoteSetupCopy.addServer}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
          {remoteSetupCopy.connectionStorage}
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ px: 3, pb: 3 }}>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <Stack spacing={1.5}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {remoteSetupCopy.connectionDetails}
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                label={remoteSetupCopy.sshAlias}
                placeholder={remoteSetupCopy.aliasExample}
                value={draft.hostAlias}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    hostAlias: event.target.value,
                    label: event.target.value
                  })
                }
                slotProps={{ input: { readOnly: Boolean(draft.id) } }}
                autoFocus={!draft.id}
                fullWidth
              />
              {!legacy && (
                <TextField
                  label={remoteSetupCopy.serverAddress}
                  placeholder={remoteSetupCopy.hostnamePlaceholder}
                  value={draft.hostname}
                  onChange={(event) => onDraftChange({ ...draft, hostname: event.target.value })}
                  fullWidth
                />
              )}
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                label={remoteSetupCopy.username}
                placeholder={remoteSetupCopy.usernameExample}
                value={draft.user}
                onChange={(event) => onDraftChange({ ...draft, user: event.target.value })}
                fullWidth
              />
              <TextField
                label={remoteSetupCopy.port}
                placeholder="22"
                value={draft.port}
                onChange={(event) => onDraftChange({ ...draft, port: event.target.value })}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                sx={{ width: { xs: '100%', sm: 160 }, flexShrink: 0 }}
              />
            </Stack>
          </Stack>

          {!legacy && (
            <FormControl>
              <FormLabel id="remote-host-authentication-label" sx={{ mb: 1, fontWeight: 700 }}>
                {remoteSetupCopy.authentication}
              </FormLabel>
              <RadioGroup
                aria-labelledby="remote-host-authentication-label"
                value={authMode}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    authMode: event.target.value as RemoteHostAuthMode
                  })
                }
                sx={{ gap: 1 }}
              >
                <AuthenticationOption
                  value="passwordless"
                  selected={authMode === 'passwordless'}
                  title={remoteSetupCopy.passwordlessRecommended}
                  description={remoteSetupCopy.passwordlessDescription}
                  disabled={!onPasswordBootstrap}
                />
                <AuthenticationOption
                  value="existing-key"
                  selected={authMode === 'existing-key'}
                  title={remoteSetupCopy.existingSshConfiguration}
                  description={remoteSetupCopy.existingSshDescription}
                />
              </RadioGroup>
            </FormControl>
          )}

          {authMode === 'existing-key' && (
            <TextField
              label={remoteSetupCopy.privateKeyPath}
              placeholder="~/.ssh/id_ed25519"
              value={draft.identityFile}
              helperText={
                legacy
                  ? remoteSetupCopy.legacyConnectionStorage
                  : remoteSetupCopy.defaultSshAuthentication
              }
              onChange={(event) => onDraftChange({ ...draft, identityFile: event.target.value })}
              fullWidth
            />
          )}
          {error && <Alert severity="error">{localizeRemoteSetupMessage(error)}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2.25, borderTop: 1, borderColor: 'divider' }}>
        <Button onClick={onClose} disabled={busy}>
          {remoteSetupCopy.cancel}
        </Button>
        <Button
          variant="contained"
          disabled={busy || (configuringPasswordless ? !passwordlessReady : !connectionReady)}
          onClick={configuringPasswordless ? onPasswordBootstrap : onSave}
        >
          {configuringPasswordless
            ? remoteSetupCopy.continuePasswordless
            : draft.id
              ? remoteSetupCopy.saveChanges
              : remoteSetupCopy.addServer}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
