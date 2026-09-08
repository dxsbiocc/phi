import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useState } from 'react'
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
    return '请输入授权码'
  }
  if (prompt.type === 'secret') {
    return '请输入密钥'
  }
  return prompt.placeholder || '请输入'
}

function formatPromptHint(eventType: ActiveAuthPrompt['prompt']['type']): string {
  if (eventType === 'select') {
    return '请选择后提交'
  }
  return '请填写并提交'
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
  const [step, setStep] = useState<'select' | 'configure'>(
    initialProviderId ? 'configure' : 'select'
  )
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(initialProviderId)
  const [apiKey, setApiKey] = useState('')

  const selectedProvider = providers.find((item) => item.providerId === selectedProviderId) ?? null

  const renderPromptSection = (): React.JSX.Element | null => {
    if (!activePrompts.length) {
      return null
    }

    return (
      <Box sx={{ mt: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          授权交互输入
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
        添加 Provider
      </DialogTitle>

      <DialogContent sx={{ mt: 1 }}>
        {step === 'select' ? (
          <Box>
            <Autocomplete
              options={providers}
              autoFocus
              getOptionLabel={(provider) => `${provider.name}（${provider.providerId}）`}
              onChange={(_, value) => {
                if (!value) {
                  return
                }
                setSelectedProviderId(value.providerId)
                setStep('configure')
                onSelectProvider(value)
                setApiKey('')
              }}
              renderInput={(params) => (
                <TextField {...params} label="搜索 Provider" placeholder="输入名称或 ID" />
              )}
            />
          </Box>
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

            <Typography variant="subtitle2">OAuth 登录</Typography>
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
                OAuth 登录
              </Button>
            ) : (
              <Alert severity="warning" sx={{ mt: 1 }}>
                当前 Provider 未启用 OAuth
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
                  placeholder="输入 API Key"
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
                  保存 API Key
                </Button>
              </form>
            ) : (
              <Alert severity="warning" sx={{ mt: 1 }}>
                当前 Provider 未启用 API Key
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
            返回
          </Button>
        ) : null}
        <Button onClick={onClose} sx={{ minHeight: 44 }}>
          关闭
        </Button>
        {isProcessing ? <CircularProgress size={20} sx={{ mr: 2 }} /> : null}
      </DialogActions>
    </Dialog>
  )
}

function AddProviderDialog(props: AddProviderDialogProps): React.JSX.Element {
  const dialogSessionKey = props.open ? (props.initialProviderId ?? 'select') : 'closed'
  return <AddProviderDialogContent key={dialogSessionKey} {...props} />
}

export default AddProviderDialog
