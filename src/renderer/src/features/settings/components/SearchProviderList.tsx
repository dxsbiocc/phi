import { useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  Menu,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Tabs,
  TextField,
  Typography
} from '@mui/material'
import { GoKebabHorizontal, GoSearch } from 'react-icons/go'
import type {
  WebSearchKeyStatus,
  WebSearchProviderOption
} from '../../../../../shared/webSearchSettingsTypes'
import {
  listSearchProviderPage,
  type SearchProviderCostFilter,
  type SearchProviderEnabledFilter
} from '../lib/searchProviderList'
import { TabLabel } from './TabCountBadge'

function authDescription(provider: WebSearchProviderOption): string {
  switch (provider.auth) {
    case 'none':
      return '免认证'
    case 'optional':
      return '可选 Key'
    case 'api-key':
      return 'API Key'
    case 'oauth-or-key':
      return 'Key / 授权'
    case 'oauth':
      return '账号授权'
    case 'endpoint':
      return '实例地址'
  }
}

function costLabel(access: WebSearchProviderOption['access']): string {
  return access === 'free' ? '免费' : access === 'metered' ? '可能收费' : '自建'
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
  const [costFilter, setCostFilter] = useState<SearchProviderCostFilter>('all')
  const [enabledFilter, setEnabledFilter] = useState<SearchProviderEnabledFilter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(5)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [menuProvider, setMenuProvider] = useState<WebSearchProviderOption | null>(null)
  const [keyProvider, setKeyProvider] = useState<WebSearchProviderOption | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyStatus, setKeyStatus] = useState<Record<string, WebSearchKeyStatus>>({})

  const result = listSearchProviderPage(providers, enabledIds, {
    cost: costFilter,
    enabled: enabledFilter,
    query,
    page,
    rowsPerPage
  })
  const menuIndex = menuProvider ? enabledIds.indexOf(menuProvider.id) : -1
  const menuCanSetKey =
    menuProvider?.auth === 'api-key' ||
    menuProvider?.auth === 'oauth-or-key' ||
    menuProvider?.auth === 'optional'
  const menuCanLogin = menuProvider?.auth === 'oauth' || menuProvider?.auth === 'oauth-or-key'
  const menuHasStoredKey = menuProvider
    ? (keyStatus[menuProvider.id]?.apiKeyStored ?? menuProvider.apiKeyStored ?? false)
    : false

  function closeMenu(): void {
    setMenuAnchor(null)
    setMenuProvider(null)
  }

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
      <Card>
        <Tabs
          value={costFilter}
          onChange={(_, value: SearchProviderCostFilter) => {
            setCostFilter(value)
            setPage(0)
          }}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="按费用类型筛选搜索服务"
          sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="all" label={<TabLabel text="全部" count={providers.length} />} />
          <Tab
            value="free"
            label={
              <TabLabel
                text="免凭据"
                count={providers.filter((provider) => provider.access === 'free').length}
                tone="success"
              />
            }
          />
          <Tab
            value="metered"
            label={
              <TabLabel
                text="账号 / API"
                count={providers.filter((provider) => provider.access === 'metered').length}
                tone="warning"
              />
            }
          />
          <Tab
            value="self-hosted"
            label={
              <TabLabel
                text="自建"
                count={providers.filter((provider) => provider.access === 'self-hosted').length}
              />
            }
          />
        </Tabs>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ px: 3, py: 2.5, borderBottom: 1, borderColor: 'divider', alignItems: 'center' }}
        >
          <FormControl size="small" sx={{ minWidth: 145 }}>
            <InputLabel id="web-search-enabled-filter-label">启用状态</InputLabel>
            <Select
              labelId="web-search-enabled-filter-label"
              label="启用状态"
              value={enabledFilter}
              onChange={(event) => {
                setEnabledFilter(event.target.value as SearchProviderEnabledFilter)
                setPage(0)
              }}
            >
              <MenuItem value="all">全部状态</MenuItem>
              <MenuItem value="enabled">已启用</MenuItem>
              <MenuItem value="disabled">已关闭</MenuItem>
            </Select>
          </FormControl>
          <TextField
            fullWidth
            size="small"
            placeholder="搜索服务名称或 ID"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <GoSearch size={17} />
                  </InputAdornment>
                )
              }
            }}
          />
        </Stack>
        <TableContainer>
          <Table
            size="small"
            sx={{
              minWidth: 620,
              '& th:first-of-type, & td:first-of-type': { pl: 3 },
              '& th:last-of-type, & td:last-of-type': { pr: 3 }
            }}
            aria-label="网页搜索服务来源列表"
          >
            <TableHead>
              <TableRow sx={{ bgcolor: 'action.hover' }}>
                <TableCell sx={{ width: 68 }}>使用</TableCell>
                <TableCell sx={{ width: 160 }}>服务</TableCell>
                <TableCell sx={{ width: 100 }}>费用</TableCell>
                <TableCell>认证方式</TableCell>
                <TableCell sx={{ width: 75 }}>优先级</TableCell>
                <TableCell align="right" sx={{ width: 68 }}>
                  操作
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {result.rows.map((provider) => {
                const index = enabledIds.indexOf(provider.id)
                const enabled = index >= 0
                const canSetKey =
                  provider.auth === 'api-key' ||
                  provider.auth === 'oauth-or-key' ||
                  provider.auth === 'optional'
                const canLogin = provider.auth === 'oauth' || provider.auth === 'oauth-or-key'
                const hasKey =
                  keyStatus[provider.id]?.apiKeyConfigured ?? provider.apiKeyConfigured ?? false
                return (
                  <TableRow key={provider.id} hover>
                    <TableCell padding="checkbox">
                      <Switch
                        size="small"
                        checked={enabled}
                        disabled={disabled || (enabled && enabledIds.length === 1)}
                        onChange={() => onToggle(provider.id)}
                        slotProps={{ input: { 'aria-label': `启用 ${provider.label} 搜索` } }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {provider.label}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontFamily: 'var(--font-mono)' }}
                      >
                        {provider.id}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={costLabel(provider.access)} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {authDescription(provider)}
                      </Typography>
                      {(hasKey || provider.oauthConfigured) && (
                        <Stack direction="row" spacing={0.5} sx={{ mt: 0.25 }}>
                          {hasKey && <Chip size="small" color="success" label="已配置 Key" />}
                          {provider.oauthConfigured && (
                            <Chip size="small" color="success" label="已授权" />
                          )}
                        </Stack>
                      )}
                      {(canSetKey || canLogin) && (
                        <Stack direction="row" spacing={0.5} sx={{ mt: 0.25, flexWrap: 'wrap' }}>
                          {canSetKey && onSetApiKey && (
                            <Button
                              size="small"
                              disabled={disabled || busy}
                              onClick={() => setKeyProvider(provider)}
                            >
                              {hasKey ? '更换 Key' : '填写 Key'}
                            </Button>
                          )}
                          {canLogin && onOpenProviderSettings && (
                            <Button
                              size="small"
                              disabled={disabled || busy}
                              onClick={onOpenProviderSettings}
                            >
                              账号授权
                            </Button>
                          )}
                        </Stack>
                      )}
                    </TableCell>
                    <TableCell>{enabled ? `#${index + 1}` : '—'}</TableCell>
                    <TableCell align="right">
                      <IconButton
                        size="small"
                        aria-label={`更多 ${provider.label} 操作`}
                        disabled={disabled || busy}
                        onClick={(event) => {
                          setMenuProvider(provider)
                          setMenuAnchor(event.currentTarget)
                        }}
                      >
                        <GoKebabHorizontal size={18} />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                )
              })}
              {result.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                    没有符合条件的搜索服务
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={result.total}
          page={result.page}
          onPageChange={(_, nextPage) => setPage(nextPage)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(event) => {
            setRowsPerPage(Number(event.target.value))
            setPage(0)
          }}
          rowsPerPageOptions={[5, 10, 20]}
          labelRowsPerPage="每页"
          labelDisplayedRows={({ from, to, count }) => `${from}–${to} / ${count}`}
          sx={{ '& .MuiTablePagination-toolbar': { pl: 3 } }}
        />
      </Card>
      {error && <Alert severity="error">{error}</Alert>}
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        {menuProvider && menuIndex > 0 && (
          <MenuItem
            onClick={() => {
              onPrioritize(menuProvider.id)
              closeMenu()
            }}
          >
            置顶
          </MenuItem>
        )}
        {menuProvider && menuIndex > 0 && (
          <MenuItem
            onClick={() => {
              onMove(menuProvider.id, -1)
              closeMenu()
            }}
          >
            上移
          </MenuItem>
        )}
        {menuProvider && menuIndex >= 0 && menuIndex < enabledIds.length - 1 && (
          <MenuItem
            onClick={() => {
              onMove(menuProvider.id, 1)
              closeMenu()
            }}
          >
            下移
          </MenuItem>
        )}
        {menuProvider && menuCanSetKey && onSetApiKey && (
          <MenuItem
            onClick={() => {
              setError(null)
              setKeyProvider(menuProvider)
              closeMenu()
            }}
          >
            {(keyStatus[menuProvider.id]?.apiKeyConfigured ?? menuProvider.apiKeyConfigured)
              ? '更换 API Key'
              : '填写 API Key'}
          </MenuItem>
        )}
        {menuProvider && menuHasStoredKey && onClearApiKey && (
          <MenuItem
            onClick={() => {
              void clearKey(menuProvider)
              closeMenu()
            }}
          >
            清除 Key
          </MenuItem>
        )}
        {menuProvider && menuCanLogin && onOpenProviderSettings && (
          <MenuItem
            onClick={() => {
              closeMenu()
              onOpenProviderSettings()
            }}
          >
            账号授权
          </MenuItem>
        )}
        {menuProvider && menuIndex < 0 && !menuCanSetKey && !menuCanLogin && (
          <MenuItem disabled>使用开关启用</MenuItem>
        )}
      </Menu>
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
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            {keyProvider?.apiKeyUrl && (
              <Button
                component="a"
                href={keyProvider.apiKeyUrl}
                target="_blank"
                rel="noreferrer"
                size="small"
                sx={{ alignSelf: 'flex-start', pl: 0 }}
              >
                前往 {keyProvider.label} 获取 Key ↗
              </Button>
            )}
            <TextField
              autoFocus
              fullWidth
              type="password"
              label="API Key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              helperText={
                keyProvider?.apiKeyEnv ? `全局凭据 · 也可设置 ${keyProvider.apiKeyEnv}` : '全局凭据'
              }
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
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
