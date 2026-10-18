import { useUiLanguage } from '../../../lib/i18n'
import { localizeRemoteSetupMessage, remoteSetupCopy } from '../lib/remoteSetupCopy'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography
} from '@mui/material'

import { useRemoteHostPasswordBootstrap } from '../hooks/useRemoteHostPasswordBootstrap'
import type {
  RemoteHostPasswordBootstrapClient,
  SshBootstrapFinalResult,
  SshBootstrapTarget,
  SshBootstrapUiActions,
  SshBootstrapUiModel
} from '../lib/sshBootstrapUi'

export function RemoteHostPasswordBootstrapDialog({
  open,
  target,
  client,
  onClose,
  onCompleted
}: {
  open: boolean
  target: SshBootstrapTarget
  client: RemoteHostPasswordBootstrapClient
  onClose: () => void
  onCompleted?: (result: SshBootstrapFinalResult) => void
}): React.JSX.Element | null {
  useUiLanguage()
  if (!open) return null
  const targetKey = `${target.alias}\0${target.hostname}\0${target.user}\0${target.port}`
  return (
    <RemoteHostPasswordBootstrapSession
      key={targetKey}
      target={target}
      client={client}
      onClose={onClose}
      onCompleted={onCompleted}
    />
  )
}

function RemoteHostPasswordBootstrapSession({
  target,
  client,
  onClose,
  onCompleted
}: {
  target: SshBootstrapTarget
  client: RemoteHostPasswordBootstrapClient
  onClose: () => void
  onCompleted?: (result: SshBootstrapFinalResult) => void
}): React.JSX.Element {
  useUiLanguage()
  const controller = useRemoteHostPasswordBootstrap({ target, client, onClose, onCompleted })
  return (
    <RemoteHostPasswordBootstrapDialogView
      open
      model={controller.model}
      actions={controller.actions}
    />
  )
}

export function RemoteHostPasswordBootstrapDialogView({
  open,
  model,
  actions
}: {
  open: boolean
  model: SshBootstrapUiModel
  actions: SshBootstrapUiActions
}): React.JSX.Element {
  useUiLanguage()
  const confirmingHostKey = model.phase === 'host-key-confirmation'
  const enteringPassword = model.phase === 'password'
  const choosingPasswordless = model.phase === 'password-choice'
  const skippedPasswordless = model.phase === 'skipped'
  const enteringCredentials = model.phase === 'credentials'
  const progressing = model.phase === 'progress'
  const testingPassword =
    progressing &&
    localizeRemoteSetupMessage(model.currentStep) === remoteSetupCopy.testingPasswordStep
  const previewingConfig = model.phase === 'config-preview'
  const showingResult = model.phase === 'result'
  return (
    <Dialog open={open} onClose={model.busy ? undefined : actions.close} maxWidth="sm" fullWidth>
      <DialogTitle>
        {confirmingHostKey
          ? remoteSetupCopy.confirmHostKey
          : choosingPasswordless
            ? remoteSetupCopy.passwordConnectionSucceeded
            : skippedPasswordless
              ? remoteSetupCopy.connectionEnded
              : enteringPassword
                ? remoteSetupCopy.testPasswordConnection
                : enteringCredentials
                  ? remoteSetupCopy.configurePasswordless
                  : testingPassword
                    ? remoteSetupCopy.testingPasswordConnection
                    : progressing
                      ? remoteSetupCopy.settingUpPasswordless
                      : previewingConfig
                        ? remoteSetupCopy.confirmSshConfiguration
                        : showingResult
                          ? remoteSetupCopy.passwordlessReady
                          : remoteSetupCopy.setUpPasswordless}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.75 }}>
          <Typography variant="body2">
            {remoteSetupCopy.targetAliasPrefix}
            {model.target.alias}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {model.target.user}@{model.target.hostname}:{model.target.port}
          </Typography>
          {confirmingHostKey ? (
            <>
              {model.fingerprints.map((fingerprint) => (
                <Stack key={`${fingerprint.algorithm}:${fingerprint.sha256}`} spacing={0.25}>
                  <Typography variant="caption" color="text.secondary">
                    {fingerprint.algorithm}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                  >
                    {fingerprint.sha256}
                  </Typography>
                </Stack>
              ))}
              <Typography variant="body2">{remoteSetupCopy.verifyFingerprint}</Typography>
            </>
          ) : choosingPasswordless ? (
            <>
              <Alert severity="success">{remoteSetupCopy.passwordTestSucceeded}</Alert>
              <Typography variant="body2">{remoteSetupCopy.recommendPasswordless}</Typography>
            </>
          ) : skippedPasswordless ? (
            <>
              <Alert severity="info">{remoteSetupCopy.passwordDiscarded}</Alert>
              <Typography variant="body2">{remoteSetupCopy.futurePasswordHelp}</Typography>
            </>
          ) : enteringPassword ? (
            <>
              <TextField
                label={remoteSetupCopy.serverPassword}
                type="password"
                value={model.password}
                onChange={(event) => actions.setPassword(event.target.value)}
                autoComplete="off"
                autoFocus
                fullWidth
              />
              <Alert severity="info">{remoteSetupCopy.passwordUseHelp}</Alert>
            </>
          ) : enteringCredentials ? (
            <>
              {!model.passwordlessAcknowledged && (
                <>
                  <TextField
                    label={remoteSetupCopy.keyPassphrase}
                    type="password"
                    value={model.credentials.passphrase}
                    onChange={(event) => actions.setPassphrase(event.target.value)}
                    autoComplete="new-password"
                    helperText={remoteSetupCopy.keyPassphraseHelp}
                    fullWidth
                  />
                  <TextField
                    label={remoteSetupCopy.confirmKeyPassphrase}
                    type="password"
                    value={model.credentials.passphraseConfirmation}
                    onChange={(event) => actions.setPassphraseConfirmation(event.target.value)}
                    autoComplete="new-password"
                    error={Boolean(
                      model.credentials.passphraseConfirmation && model.validationMessage
                    )}
                    fullWidth
                  />
                </>
              )}
              {model.passwordlessAvailable && (
                <Alert severity="warning">
                  <Stack spacing={1}>
                    <Typography variant="body2">{remoteSetupCopy.linuxAgentRequired}</Typography>
                    <Button
                      size="small"
                      onClick={actions.startInspection}
                      sx={{ alignSelf: 'start' }}
                    >
                      {remoteSetupCopy.recheckAgent}
                    </Button>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={model.passwordlessAcknowledged}
                          onChange={(event) =>
                            actions.setPasswordlessAcknowledged(event.target.checked)
                          }
                        />
                      }
                      label={remoteSetupCopy.unprotectedKeyOption}
                    />
                  </Stack>
                </Alert>
              )}
              <Alert severity="info">{remoteSetupCopy.passphraseDiscarded}</Alert>
            </>
          ) : progressing ? (
            <>
              {model.completedSteps.map((step) => (
                <Typography
                  key={localizeRemoteSetupMessage(step)}
                  variant="body2"
                  color="success.main"
                >
                  ✓ {localizeRemoteSetupMessage(step)}
                </Typography>
              ))}
              <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
                <CircularProgress size={18} />
                <Typography variant="body2">
                  {localizeRemoteSetupMessage(model.currentStep)}
                </Typography>
              </Stack>
            </>
          ) : previewingConfig ? (
            <>
              <Alert severity="success">{remoteSetupCopy.keyVerifiedReview}</Alert>
              <Typography variant="body2">
                {remoteSetupCopy.newKeyPrefix}
                {model.keyFingerprint}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {model.keyDisplayPath}
              </Typography>
              <Box
                component="pre"
                sx={{
                  bgcolor: 'action.hover',
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.78rem',
                  m: 0,
                  overflowX: 'auto',
                  p: 1.5,
                  whiteSpace: 'pre-wrap'
                }}
              >
                {model.preview}
              </Box>
              <Typography variant="caption" color="text.secondary">
                {remoteSetupCopy.sshConfigurationConsent}
              </Typography>
            </>
          ) : showingResult ? (
            <>
              <Alert severity="success">{remoteSetupCopy.keyInstalledVerified}</Alert>
              <Typography variant="body2">
                {remoteSetupCopy.newKeyPrefix}
                {model.keyFingerprint}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {model.keyDisplayPath}
              </Typography>
              <Typography variant="body2">
                {model.configured
                  ? remoteSetupCopy.sshConfigurationUpdated
                  : remoteSetupCopy.sshConfigurationUnchanged}
              </Typography>
              {model.manualConfig && (
                <>
                  <Typography variant="subtitle2">{remoteSetupCopy.manualConfiguration}</Typography>
                  <Box
                    component="pre"
                    sx={{
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                      fontFamily: 'monospace',
                      fontSize: '0.78rem',
                      m: 0,
                      overflowX: 'auto',
                      p: 1.5,
                      whiteSpace: 'pre-wrap'
                    }}
                  >
                    {model.manualConfig}
                  </Box>
                </>
              )}
            </>
          ) : (
            <Typography variant="body2">{remoteSetupCopy.bootstrapSafetyHelp}</Typography>
          )}
          {model.error && <Alert severity="error">{localizeRemoteSetupMessage(model.error)}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {showingResult || skippedPasswordless ? (
          <Button variant="contained" onClick={actions.close}>
            {remoteSetupCopy.done}
          </Button>
        ) : choosingPasswordless ? (
          <>
            <Button onClick={actions.skipPasswordless} disabled={model.busy}>
              {remoteSetupCopy.skipSetup}
            </Button>
            <Button
              variant="contained"
              onClick={actions.configurePasswordless}
              disabled={model.busy}
            >
              {remoteSetupCopy.configurePasswordlessRecommended}
            </Button>
          </>
        ) : previewingConfig ? (
          <>
            <Button onClick={actions.declineConfig} disabled={model.busy}>
              {remoteSetupCopy.skipWrite}
            </Button>
            <Button variant="contained" onClick={actions.saveConfig} disabled={model.busy}>
              {model.busy ? remoteSetupCopy.writing : remoteSetupCopy.approveSshConfiguration}
            </Button>
          </>
        ) : !progressing ? (
          <>
            <Button onClick={actions.close} disabled={model.busy}>
              {remoteSetupCopy.cancel}
            </Button>
            <Button
              variant="contained"
              onClick={
                confirmingHostKey
                  ? actions.confirmHostKey
                  : enteringPassword
                    ? actions.verifyPassword
                    : enteringCredentials
                      ? actions.submitCredentials
                      : actions.startInspection
              }
              disabled={
                model.busy ||
                ((enteringPassword || enteringCredentials) && Boolean(model.validationMessage))
              }
            >
              {model.busy
                ? confirmingHostKey
                  ? remoteSetupCopy.writing
                  : enteringPassword
                    ? remoteSetupCopy.testing
                    : enteringCredentials
                      ? remoteSetupCopy.bootstrapping
                      : remoteSetupCopy.checking
                : confirmingHostKey
                  ? remoteSetupCopy.fingerprintMatches
                  : enteringPassword
                    ? remoteSetupCopy.testConnection
                    : enteringCredentials
                      ? remoteSetupCopy.startBootstrap
                      : remoteSetupCopy.startSafetyCheck}
            </Button>
          </>
        ) : null}
      </DialogActions>
    </Dialog>
  )
}
