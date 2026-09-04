import { Add as AddIcon, Logout as LogoutIcon, Key as KeyIcon, Shield as ShieldIcon } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import type { ProviderAuthStatus } from '../types'

type ViewProps = {
  providers: ProviderAuthStatus[]
  providerHints: Record<string, string>
  onRefresh: () => Promise<void>
  onOpenAddProvider: () => void
  onLogout: (providerId: string) => void
}

function ProviderCard({
  provider,
  hint,
  onLogout,
}: {
  provider: ProviderAuthStatus
  hint?: string
  onLogout: (providerId: string) => void
}): React.JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
      <ListItem disablePadding>
        <ListItemText
          primary={<Typography variant="h6">{provider.name}</Typography>}
          secondary={
            <Typography variant="body2" sx={{ mt: 0.5, fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
              {provider.providerId}
            </Typography>
          }
        />
        <Chip
          size="small"
          color={provider.configured ? 'success' : 'default'}
          label={provider.configured ? '已配置' : '未配置'}
        />
      </ListItem>

      <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
        {provider.hasApiKey && <Chip size="small" icon={<KeyIcon />} label="API Key" />}
        {provider.hasOAuth && <Chip size="small" icon={<ShieldIcon />} label="OAuth" />}
        {provider.statusText && <Chip size="small" label={provider.statusText} variant="outlined" />}
      </Stack>

      {hint ? (
        <Alert severity="info" sx={{ mt: 2 }}>
          <Typography variant="body2">{hint}</Typography>
        </Alert>
      ) : null}

      {provider.configured && (
        <Button
          variant="outlined"
          color="error"
          size="small"
          onClick={() => {
            onLogout(provider.providerId)
          }}
          startIcon={<LogoutIcon />}
          sx={{ mt: 2, minHeight: 44 }}
        >
          登出
        </Button>
      )}
    </Paper>
  )
}

function SettingsView({ providers, providerHints, onRefresh, onOpenAddProvider, onLogout }: ViewProps): React.JSX.Element {
  const configuredProviders = providers.filter((item) => item.configured)

  return (
    <Box sx={{ height: '100%', p: 2, overflowY: 'auto', minHeight: 0 }}>
      <Stack spacing={2}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="h5" component="h1">
            Provider 配置
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={onRefresh} sx={{ minHeight: 44 }}>
              刷新状态
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={onOpenAddProvider} sx={{ minHeight: 44 }}>
              添加 Provider
            </Button>
          </Stack>
        </Box>

        <Divider />

        <Typography variant="subtitle1" color="text.secondary">
          已配置的 Provider
        </Typography>

        {configuredProviders.length === 0 ? (
          <Paper sx={{ p: 3, borderRadius: 2 }}>
            <Alert severity="warning" sx={{ mb: 2 }}>
              <Typography variant="body1">尚未配置任何 Provider</Typography>
            </Alert>
            <Button variant="contained" onClick={onOpenAddProvider} startIcon={<AddIcon />} sx={{ minHeight: 44 }}>
              先添加 Provider
            </Button>
          </Paper>
        ) : (
          <List disablePadding>
            {configuredProviders.map((provider, index) => (
              <Box key={provider.providerId} sx={{ mb: index === configuredProviders.length - 1 ? 0 : 1.5 }}>
                <ProviderCard
                  provider={provider}
                  hint={providerHints[provider.providerId]}
                  onLogout={onLogout}
                />
              </Box>
            ))}
          </List>
        )}
      </Stack>
    </Box>
  )
}

export default SettingsView
