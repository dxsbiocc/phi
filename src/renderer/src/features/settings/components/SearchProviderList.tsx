import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import { GoChevronDown, GoChevronUp } from 'react-icons/go'
import type {
  WebSearchKeyStatus,
  WebSearchProviderOption
} from '../../../../../shared/webSearchSettingsTypes'

const GROUPS = [
  { id: 'free', title: '免凭据可用', note: '无需搜索 API 账号；公开网页抓取可能限流或遇到验证。' },
  {
    id: 'metered',
    title: '账号或 API 服务',
    note: '可能有免费额度或需要付费；实际资费由服务商决定。'
  },
  { id: 'self-hosted', title: '自建实例', note: '无需第三方搜索 API Key；实例运行可能产生费用。' }
] as const

function authDescription(provider: WebSearchProviderOption): string {
  switch (provider.auth) {
    case 'none':
      return '无需凭据'
    case 'optional':
      return provider.id === 'perplexity'
        ? '匿名模式可用；可选 API Key'
        : '免凭据后备可用；可选 API Key'
    case 'api-key':
      return `需要 API Key${provider.apiKeyEnv ? `（也可设置 ${provider.apiKeyEnv}）` : ''}`
    case 'oauth-or-key':
      return `需要账号授权或 API Key${provider.apiKeyEnv ? `（也可设置 ${provider.apiKeyEnv}）` : ''}`
    case 'oauth':
      return '需要账号授权'
    case 'endpoint':
      return '需要实例地址'
  }
}

export function SearchProviderList({
  providers,
  enabledIds,
  disabled,
  onToggle,
  onMove,
  onPrioritize,
  onSetApiKey,
  onClearApiKey,
  onOpenProviderSettings
}: {
  providers: WebSearchProviderOption[]
  enabledIds: string[]
  disabled: boolean
  onToggle: (id: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onPrioritize: (id: string) => void
  onSetApiKey?: (id: string, key: string) => Promise<WebSearchKeyStatus>
  onClearApiKey?: (id: string) => Promise<WebSearchKeyStatus>
  onOpenProviderSettings?: () => void
}): React.JSX.Element {
  const [keyProvider, setKeyProvider] = useState<WebSearchProviderOption | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyStatus, setKeyStatus] = useState<Record<string, WebSearchKeyStatus>>({})

  async function saveKey(): Promise<void> {
    if (!keyProvider || !onSetApiKey) return
    setBusy(true)
    setError(null)
    try {
      const status = await onSetApiKey(keyProvider.id, key)
      setKeyStatus((current) => ({ ...current, [keyProvider.id]: status }))
      setKey('')
      setKeyProvider(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function clearKey(provider: WebSearchProviderOption): Promise<void> {
    if (!onClearApiKey) return
    setBusy(true)
    setError(null)
    try {
      const status = await onClearApiKey(provider.id)
      setKeyStatus((current) => ({ ...current, [provider.id]: status }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Paper variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
        <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="body2" color="text.secondary">
            已启用 {enabledIds.length} / {providers.length} · 编号表示跨组搜索优先级
          </Typography>
          <Typography variant="caption" color="text.secondary">
            启用只决定搜索顺序；需要凭据的服务仍须完成配置。API Key 与 Provider 共用全局凭据。
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {GROUPS.map(
              (group) =>
                `${group.title} ${providers.filter((provider) => provider.access === group.id).length}`
            ).join(' · ')}
          </Typography>
        </Box>
        <Box sx={{ maxHeight: 420, overflowY: 'auto' }}>
          {GROUPS.map((group) => {
            const members = providers
              .filter((provider) => provider.access === group.id)
              .sort((left, right) => {
                const leftIndex = enabledIds.indexOf(left.id)
                const rightIndex = enabledIds.indexOf(right.id)
                if (leftIndex === -1 && rightIndex === -1) return 0
                if (leftIndex === -1) return 1
                if (rightIndex === -1) return -1
                return leftIndex - rightIndex
              })
            if (members.length === 0) return null
            return (
              <Box key={group.id}>
                <Box
                  sx={{
                    px: 1.5,
                    py: 1,
                    bgcolor: 'action.hover',
                    borderBottom: 1,
                    borderColor: 'divider'
                  }}
                >
                  <Typography variant="subtitle2">
                    {group.title}（{members.length}）
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {group.note}
                  </Typography>
                </Box>
                {members.map((provider) => {
                  const index = enabledIds.indexOf(provider.id)
                  const enabled = index >= 0
                  const canSetKey =
                    provider.auth === 'api-key' ||
                    provider.auth === 'oauth-or-key' ||
                    provider.auth === 'optional'
                  const canLogin = provider.auth === 'oauth' || provider.auth === 'oauth-or-key'
                  const hasKey =
                    keyStatus[provider.id]?.apiKeyConfigured ?? provider.apiKeyConfigured ?? false
                  const hasStoredKey =
                    keyStatus[provider.id]?.apiKeyStored ?? provider.apiKeyStored ?? false
                  return (
                    <Box
                      key={provider.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        px: 1.5,
                        py: 1,
                        borderBottom: 1,
                        borderColor: 'divider'
                      }}
                    >
                      <Switch
                        checked={enabled}
                        disabled={disabled || (enabled && enabledIds.length === 1)}
                        onChange={() => onToggle(provider.id)}
                        slotProps={{ input: { 'aria-label': `启用 ${provider.label} 搜索` } }}
                      />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Stack
                          direction="row"
                          spacing={0.5}
                          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                        >
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {provider.label}
                          </Typography>
                          <Chip
                            size="small"
                            label={
                              provider.access === 'free'
                                ? '免费入口'
                                : provider.access === 'metered'
                                  ? '套餐计费'
                                  : '自建'
                            }
                          />
                          {enabled && (
                            <Chip size="small" variant="outlined" label={`#${index + 1}`} />
                          )}
                          {hasKey && <Chip size="small" color="success" label="已配置 Key" />}
                          {provider.oauthConfigured && (
                            <Chip size="small" color="success" label="已授权" />
                          )}
                        </Stack>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block' }}
                        >
                          {authDescription(provider)}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: 'var(--font-mono)' }}
                        >
                          {provider.id}
                        </Typography>
                        {(canSetKey || canLogin) && (
                          <Stack direction="row" spacing={0.5} sx={{ mt: 0.25, flexWrap: 'wrap' }}>
                            {canSetKey && onSetApiKey && (
                              <Button
                                size="small"
                                disabled={disabled || busy}
                                onClick={() => {
                                  setError(null)
                                  setKeyProvider(provider)
                                }}
                              >
                                {hasKey ? '更换 API Key' : '填写 API Key'}
                              </Button>
                            )}
                            {hasStoredKey && onClearApiKey && (
                              <Button
                                size="small"
                                color="error"
                                disabled={disabled || busy}
                                onClick={() => void clearKey(provider)}
                              >
                                清除 Key
                              </Button>
                            )}
                            {canLogin && onOpenProviderSettings && (
                              <Button
                                size="small"
                                disabled={disabled || busy}
                                onClick={onOpenProviderSettings}
                              >
                                到 Provider 设置授权
                              </Button>
                            )}
                          </Stack>
                        )}
                      </Box>
                      {enabled && (
                        <Stack direction="row" spacing={0.25}>
                          {index > 0 && (
                            <Button
                              size="small"
                              disabled={disabled}
                              onClick={() => onPrioritize(provider.id)}
                            >
                              置顶
                            </Button>
                          )}
                          <IconButton
                            size="small"
                            aria-label={`上移 ${provider.label}`}
                            disabled={disabled || index === 0}
                            onClick={() => onMove(provider.id, -1)}
                          >
                            <GoChevronUp size={18} />
                          </IconButton>
                          <IconButton
                            size="small"
                            aria-label={`下移 ${provider.label}`}
                            disabled={disabled || index === enabledIds.length - 1}
                            onClick={() => onMove(provider.id, 1)}
                          >
                            <GoChevronDown size={18} />
                          </IconButton>
                        </Stack>
                      )}
                    </Box>
                  )
                })}
              </Box>
            )
          })}
        </Box>
      </Paper>
      {error && <Alert severity="error">{error}</Alert>}
      <Dialog
        open={Boolean(keyProvider)}
        onClose={
          busy
            ? undefined
            : () => {
                setKeyProvider(null)
                setKey('')
                setError(null)
              }
        }
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{keyProvider?.label} API Key</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            type="password"
            label="API Key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            helperText={`保存在 OMP 凭据存储中，供搜索及同一 Provider 使用。${keyProvider?.apiKeyEnv ? `也可通过 ${keyProvider.apiKeyEnv} 配置。` : ''}`}
            sx={{ mt: 1 }}
          />
          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            disabled={busy}
            onClick={() => {
              setKeyProvider(null)
              setKey('')
              setError(null)
            }}
          >
            取消
          </Button>
          <Button variant="contained" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
