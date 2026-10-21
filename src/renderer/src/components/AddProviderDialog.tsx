import {
  filterProviders,
  providerCapabilityLabel
} from '../features/settings/lib/providerCapabilities'
import { settingsUi } from '../features/settings/lib/settingsUi'
import { useUiLanguage } from '../lib/i18n'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useRef, useState } from 'react'
import { PhiIcons } from '../icons'
import type { ActiveAuthPrompt, ProviderAuthStatus } from '../types'

const CheckCircleIcon = PhiIcons.state.done
const KeyIcon = PhiIcons.action.saveKey
const LoginIcon = PhiIcons.action.login

type AddProviderDialogProps = {
  open: boolean
  providers: ProviderAuthStatus[]
  initialProviderId: string | null
  activePrompts: ActiveAuthPrompt[]
  providerHint: string
  isProcessing: boolean
  onClose: () => void
  onSelectProvider: (provider: ProviderAuthStatus) => void
  onBackToList: () => void
  onSubmitApiKey: (providerId: string, key: string) => Promise<void>
  onStartOAuth: (providerId: string) => Promise<void>
  onSubmitPrompt: (requestId: string, value: string) => Promise<void>
  onUpdatePromptValue: (requestId: string, value: string) => void
}

function promptInputLabel(prompt: ActiveAuthPrompt['prompt']): string {
  if (prompt.type === 'manual_code') {
    return settingsUi.enterAuthorizationCode
  }
  if (prompt.type === 'secret') {
    return settingsUi.enterKey2
  }
  return prompt.placeholder || settingsUi.enterAValue
}

function formatPromptHint(eventType: ActiveAuthPrompt['prompt']['type']): string {
  if (eventType === 'select') {
    return settingsUi.selectAnOptionAndSubmit
  }
  return settingsUi.completeTheFieldAndSubmit
}

function AddProviderDialogContent({
  open,
  providers,
  initialProviderId,
  activePrompts,
  providerHint,
  isProcessing,
  onClose,
  onSelectProvider,
  onBackToList,
  onSubmitApiKey,
  onStartOAuth,
  onSubmitPrompt,
  onUpdatePromptValue
}: AddProviderDialogProps): React.JSX.Element {
  useUiLanguage()
  const [step, setStep] = useState<'select' | 'configure'>(
    initialProviderId ? 'configure' : 'select'
  )
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(initialProviderId)
  const [apiKey, setApiKey] = useState('')
  const [providerQuery, setProviderQuery] = useState('')
  const providerListRef = useRef<HTMLUListElement>(null)

  const selectedProvider = providers.find((item) => item.providerId === selectedProviderId) ?? null
  const visibleProviders = filterProviders(providers, providerQuery)

  const focusProviderOption = (index: number): void => {
    const options = providerListRef.current?.querySelectorAll<HTMLButtonElement>('button')
    options?.[index]?.focus()
  }

  const selectProvider = (provider: ProviderAuthStatus): void => {
    setSelectedProviderId(provider.providerId)
    setStep('configure')
    onSelectProvider(provider)
    setApiKey('')
  }

  const renderPromptSection = (): React.JSX.Element | null => {
    if (!activePrompts.length) {
      return null
    }

    return (
      <Box sx={{ mt: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {settingsUi.authorizationInput}
        </Typography>
        <Stack spacing={1.5}>
          {activePrompts.map((item) => (
            <Paper key={item.requestId} variant="outlined" sx={{ p: 2 }}>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {item.prompt.message}
              </Typography>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void onSubmitPrompt(item.requestId, item.value)
                }}
              >
                {item.prompt.type === 'select' ? (
                  <Select
                    fullWidth
                    value={item.value || item.prompt.options?.[0]?.id || ''}
                    onChange={(event) => {
                      onUpdatePromptValue(item.requestId, String(event.target.value))
                    }}
                  >
                    {item.prompt.options?.map((option) => (
                      <MenuItem key={option.id} value={option.id}>
                        {option.label}
                        {option.description ? `（${option.description}）` : ''}
                      </MenuItem>
                    ))}
                  </Select>
                ) : (
                  <TextField
                    fullWidth
                    type={item.prompt.type === 'secret' ? 'password' : 'text'}
                    value={item.value}
                    onChange={(event) => {
                      onUpdatePromptValue(item.requestId, event.target.value)
                    }}
                    placeholder={promptInputLabel(item.prompt)}
                    slotProps={{
                      input: {
                        sx: { fontFamily: 'var(--font-mono)' }
                      }
                    }}
                  />
                )}
                <Button
                  type="submit"
                  variant="contained"
                  fullWidth
                  sx={{ mt: 1.5, minHeight: 44 }}
                  disabled={!item.value.trim()}
                >
                  {formatPromptHint(item.prompt.type)}
                </Button>
              </form>
            </Paper>
          ))}
        </Stack>
      </Box>
    )
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CheckCircleIcon />
        {settingsUi.addProvider}
      </DialogTitle>

      <DialogContent sx={{ pt: 1.5, pb: 1.5 }}>
        {step === 'select' ? (
          <Stack spacing={1.5}>
            <Box>
              <Typography
                component="label"
                htmlFor="add-provider-search"
                variant="body2"
                sx={{ fontWeight: 600 }}
              >
                {settingsUi.searchProviders2}
              </Typography>
              <TextField
                id="add-provider-search"
                autoFocus
                fullWidth
                value={providerQuery}
                onChange={(event) => setProviderQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' && visibleProviders.length > 0) {
                    event.preventDefault()
                    focusProviderOption(0)
                  }
                }}
                placeholder={settingsUi.enterANameOrID}
                sx={{ mt: 0.75 }}
              />
            </Box>
            <Box
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                overflow: 'hidden'
              }}
            >
              <List
                ref={providerListRef}
                aria-label={settingsUi.providerList}
                sx={{ py: 0.5, maxHeight: 'min(42vh, 360px)', overflowY: 'auto' }}
              >
                {visibleProviders.map((provider, index) => (
                  <ListItem key={provider.providerId} disablePadding>
                    <ListItemButton
                      component="button"
                      type="button"
                      onClick={() => selectProvider(provider)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault()
                          focusProviderOption(
                            Math.max(
                              0,
                              Math.min(
                                visibleProviders.length - 1,
                                index + (event.key === 'ArrowDown' ? 1 : -1)
                              )
                            )
                          )
                        }
                      }}
                      sx={{ minHeight: 56, mx: 0.5, px: 1.5, gap: 1 }}
                    >
                      <ListItemText
                        primary={provider.name}
                        secondary={`${provider.providerId} · ${providerCapabilityLabel(provider)}`}
                        slotProps={{
                          primary: { sx: { fontWeight: 600, overflowWrap: 'anywhere' } },
                          secondary: {
                            sx: { fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }
                          }
                        }}
                      />
                      {provider.configured ? (
                        <Chip label={settingsUi.configured} size="small" variant="outlined" />
                      ) : null}
                    </ListItemButton>
                  </ListItem>
                ))}
                {visibleProviders.length === 0 ? (
                  <ListItem sx={{ py: 3, justifyContent: 'center' }}>
                    <Typography variant="body2" color="text.secondary">
                      {settingsUi.noMatchingProviders}
                    </Typography>
                  </ListItem>
                ) : null}
              </List>
            </Box>
          </Stack>
        ) : null}

        {step === 'configure' && selectedProvider ? (
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              {selectedProvider.name}
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5, mb: 2, fontFamily: 'var(--font-mono)' }}>
              {selectedProvider.providerId}
            </Typography>
            <Divider sx={{ mb: 2 }} />

            {providerHint ? (
              <Alert severity="info" sx={{ mb: 2 }}>
                {providerHint}
              </Alert>
            ) : null}

            <Typography variant="subtitle2">{settingsUi.oAuthLogin}</Typography>
            {selectedProvider.hasOAuth ? (
              <Button
                fullWidth
                variant="contained"
                color="success"
                startIcon={<LoginIcon />}
                onClick={() => {
                  void onStartOAuth(selectedProvider.providerId)
                }}
                sx={{ mt: 1, minHeight: 44 }}
                disabled={isProcessing}
              >
                {settingsUi.oAuthLogin}
              </Button>
            ) : (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {settingsUi.oAuthIsNotEnabledForThisProvider}
              </Alert>
            )}

            <Typography variant="subtitle2" sx={{ mt: 2 }}>
              API Key
            </Typography>
            {selectedProvider.hasApiKey ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (apiKey.trim()) {
                    void onSubmitApiKey(selectedProvider.providerId, apiKey)
                    setApiKey('')
                  }
                }}
              >
                <TextField
                  fullWidth
                  type="password"
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value)
                  }}
                  placeholder={settingsUi.enterAPIKey2}
                  sx={{ mt: 1 }}
                  slotProps={{
                    input: {
                      sx: { fontFamily: 'var(--font-mono)' }
                    }
                  }}
                />
                <Button
                  type="submit"
                  fullWidth
                  variant="outlined"
                  startIcon={<KeyIcon />}
                  sx={{ mt: 1.5, minHeight: 44 }}
                  disabled={isProcessing || !apiKey.trim()}
                >
                  {settingsUi.saveAPIKey}
                </Button>
              </form>
            ) : (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {settingsUi.aPIKeysAreNotEnabledForThisProvider}
              </Alert>
            )}

            {renderPromptSection()}
          </Box>
        ) : null}
      </DialogContent>

      <DialogActions>
        {step === 'configure' ? (
          <Button
            onClick={() => {
              setStep('select')
              onBackToList()
              setSelectedProviderId(null)
            }}
            sx={{ minHeight: 44 }}
          >
            {settingsUi.back}
          </Button>
        ) : null}
        <Button onClick={onClose} sx={{ minHeight: 44 }}>
          {settingsUi.close}
        </Button>
        {isProcessing ? <CircularProgress size={20} sx={{ mr: 2 }} /> : null}
      </DialogActions>
    </Dialog>
  )
}

function AddProviderDialog(props: AddProviderDialogProps): React.JSX.Element {
  useUiLanguage()
  const dialogSessionKey = props.open ? (props.initialProviderId ?? 'select') : 'closed'
  return <AddProviderDialogContent key={dialogSessionKey} {...props} />
}

export default AddProviderDialog
