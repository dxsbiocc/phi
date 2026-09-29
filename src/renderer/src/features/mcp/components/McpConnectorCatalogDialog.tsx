import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  Divider,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import {
  featuredMcpConnectors,
  mcpConnectorCategories,
  type FeaturedMcpConnector
} from '../../../../../shared/mcpConnectorCatalog'
import { PhiIcons } from '../../../icons'
import type { McpServerSummary } from '../../../types'
import { ConnectorIcon } from './ConnectorIcon'
import { McpFeaturedConnectorCard, type ConnectorAuthStatus } from './McpFeaturedConnectorCard'
import { McpToolList } from './McpToolList'

type CatalogPage = 'list' | 'detail' | 'custom'
type CatalogGroup = '已配置' | (typeof mcpConnectorCategories)[number]
const TOOL_LIST_CACHE_MS = 5 * 60_000
const oauthConnectors = featuredMcpConnectors.filter(
  (connector) => connector.oauthAuthorizationOrigin
)
type CachedToolNames = { names: string[]; expiresAt: number }

function freshTools(entry: CachedToolNames | undefined): entry is CachedToolNames {
  return Boolean(entry && entry.expiresAt > Date.now())
}

function cacheTools(names: string[]): CachedToolNames {
  return { names, expiresAt: Date.now() + TOOL_LIST_CACHE_MS }
}

export interface McpConnectorCatalogDialogProps {
  open: boolean
  servers: McpServerSummary[]
  onClose: () => void
  onRefresh: () => Promise<void>
}

function matchingServer(
  connector: FeaturedMcpConnector,
  servers: McpServerSummary[]
): McpServerSummary | undefined {
  return servers.find((server) => server.url === connector.url)
}

export function McpConnectorCatalogDialog({
  open,
  servers,
  onClose,
  onRefresh
}: McpConnectorCatalogDialogProps): React.JSX.Element {
  const [page, setPage] = useState<CatalogPage>('list')
  const [group, setGroup] = useState<CatalogGroup>('生产力')
  const [selectedId, setSelectedId] = useState('google-drive')
  const [query, setQuery] = useState('')
  const [customName, setCustomName] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toolNames, setToolNames] = useState<string[] | null>(null)
  const [toolsLoading, setToolsLoading] = useState(false)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [authStatusById, setAuthStatusById] = useState<Record<string, ConnectorAuthStatus>>({})
  const toolRequestRef = useRef(0)
  const toolListCacheRef = useRef(new Map<string, CachedToolNames>())

  useEffect(() => {
    if (!open) return
    let active = true
    for (const connector of oauthConnectors) {
      const cachedTools = toolListCacheRef.current.get(connector.id)
      const status =
        typeof window.api.getFeaturedMcpAuthStatus === 'function'
          ? window.api.getFeaturedMcpAuthStatus(connector.id)
          : freshTools(cachedTools)
            ? Promise.resolve(true)
            : window.api.listFeaturedMcpTools(connector.id).then((names) => {
                toolListCacheRef.current.set(connector.id, cacheTools(names))
                return true
              })
      void status
        .then((authenticated) => {
          if (active) {
            setAuthStatusById((current) => ({
              ...current,
              [connector.id]: authenticated ? 'authenticated' : 'unauthenticated'
            }))
          }
        })
        .catch((cause: unknown) => {
          if (!active) return
          const message = cause instanceof Error ? cause.message : String(cause)
          setAuthStatusById((current) => ({
            ...current,
            [connector.id]: message.includes(`请先授权登录 ${connector.name}`)
              ? 'unauthenticated'
              : 'unavailable'
          }))
        })
    }
    return () => {
      active = false
    }
  }, [open])
  const selected = featuredMcpConnectors.find((connector) => connector.id === selectedId)
  const selectedAuthStatus = authStatusById[selectedId] ?? 'checking'
  const normalizedQuery = query.trim().toLowerCase()
  const filteredFeatured = useMemo(
    () =>
      featuredMcpConnectors.filter(
        (connector) =>
          (normalizedQuery.length > 0 || connector.category === group) &&
          (!normalizedQuery ||
            [connector.name, connector.description, connector.category, connector.publisher].some(
              (value) => value.toLowerCase().includes(normalizedQuery)
            ))
      ),
    [group, normalizedQuery]
  )
  const filteredInstalled = useMemo(
    () =>
      servers.filter(
        (server) =>
          !normalizedQuery ||
          [server.name, server.url, server.command, server.sourcePath].some((value) =>
            value?.toLowerCase().includes(normalizedQuery)
          )
      ),
    [normalizedQuery, servers]
  )

  async function add(name: string, url: string): Promise<void> {
    setBusy(name)
    setError(null)
    try {
      await window.api.addRemoteMcpConnector(name, url)
      await onRefresh()
      if (page === 'custom') {
        setCustomName('')
        setCustomUrl('')
        setGroup('已配置')
        setPage('list')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function remove(server: McpServerSummary): Promise<void> {
    if (!server.url) return
    setBusy(server.name)
    setError(null)
    try {
      await window.api.removeRemoteMcpConnector(server.name, server.url)
      const connector = featuredMcpConnectors.find((entry) => entry.url === server.url)
      if (connector) toolListCacheRef.current.delete(connector.id)
      await onRefresh()
      setPage('list')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function connectOAuth(connector: FeaturedMcpConnector): Promise<void> {
    if (!connector.oauthAuthorizationOrigin) return
    if (typeof window.api.authorizeFeaturedMcp !== 'function') {
      setError('授权接口尚未加载，请重启 Phi 后重试')
      return
    }
    toolRequestRef.current += 1
    setBusy(connector.id)
    setError(null)
    setToolsError(null)
    setToolsLoading(false)
    try {
      await window.api.authorizeFeaturedMcp(connector.id)
      setAuthStatusById((current) => ({ ...current, [connector.id]: 'authenticated' }))
      toolListCacheRef.current.delete(connector.id)
      if (!matchingServer(connector, servers)) {
        await window.api.addRemoteMcpConnector(connector.id, connector.url)
        await onRefresh()
      }
      const names = await window.api.listFeaturedMcpTools(connector.id)
      toolListCacheRef.current.set(connector.id, cacheTools(names))
      setToolNames(names)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(
        /No handler registered for ['"]mcp:authorizeFeatured['"]/.test(message)
          ? '主进程尚未加载授权接口，请重启 Phi 后重试'
          : message
      )
    } finally {
      setBusy(null)
    }
  }

  function openDetail(connector: FeaturedMcpConnector, refresh = false): void {
    setSelectedId(connector.id)
    setPage('detail')
    setError(null)
    setToolNames(null)
    setToolsError(null)
    const request = ++toolRequestRef.current
    if (connector.signIn === '需要登录' && !connector.oauthAuthorizationOrigin) {
      setToolsLoading(false)
      return
    }
    if (refresh) toolListCacheRef.current.delete(connector.id)
    const cached = toolListCacheRef.current.get(connector.id)
    if (freshTools(cached)) {
      setToolNames(cached.names)
      setToolsLoading(false)
      return
    }
    if (typeof window.api.listFeaturedMcpTools !== 'function') {
      setToolsLoading(false)
      setToolsError('连接器接口尚未加载，请重新载入 Phi 窗口后重试')
      return
    }
    setToolsLoading(true)
    void window.api
      .listFeaturedMcpTools(connector.id)
      .then((names) => {
        if (request === toolRequestRef.current) {
          toolListCacheRef.current.set(connector.id, cacheTools(names))
          setToolNames(names)
        }
      })
      .catch((cause: unknown) => {
        if (request === toolRequestRef.current) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setToolsError(
            /No handler registered for ['"]mcp:featuredTools['"]/.test(message)
              ? '主进程尚未加载工具查询接口，请重新启动 Phi 后重试'
              : message
          )
        }
      })
      .finally(() => {
        if (request === toolRequestRef.current) setToolsLoading(false)
      })
  }

  function close(): void {
    toolRequestRef.current += 1
    setAuthStatusById({})
    setPage('list')
    onClose()
  }

  function openGroup(nextGroup: CatalogGroup): void {
    toolRequestRef.current += 1
    setGroup(nextGroup)
    setPage('list')
    setQuery('')
    setError(null)
  }

  function connectorCard(connector: FeaturedMcpConnector, key = connector.id): React.JSX.Element {
    return (
      <McpFeaturedConnectorCard
        key={key}
        connector={connector}
        installed={Boolean(matchingServer(connector, servers))}
        authStatus={authStatusById[connector.id] ?? 'checking'}
        busy={busy !== null}
        onOpen={() => openDetail(connector)}
        onAdd={() => void add(connector.id, connector.url)}
        onAuthorize={() => void connectOAuth(connector)}
      />
    )
  }

  function installedCard(server: McpServerSummary): React.JSX.Element {
    const connector = featuredMcpConnectors.find((entry) => entry.url === server.url)
    if (connector) return connectorCard(connector, server.id)
    return (
      <Box
        key={server.id}
        sx={{ p: 1.75, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}
      >
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <ConnectorIcon url={server.url} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 700 }}>{server.name}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {server.url ?? server.command ?? '本地 MCP 服务'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {server.enabled === false ? '已停用' : '已配置'}
            </Typography>
          </Box>
          {server.managed && server.url && (
            <Button
              size="small"
              color="error"
              disabled={busy !== null}
              onClick={() => void remove(server)}
            >
              移除
            </Button>
          )}
        </Stack>
      </Box>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: 'min(1120px, calc(100vw - 96px))',
            height: 'min(720px, calc(100vh - 96px))',
            maxHeight: 'calc(100vh - 96px)',
            borderRadius: 2,
            overflow: 'hidden'
          }
        }
      }}
    >
      <Box sx={{ display: 'flex', height: '100%', minHeight: 0, bgcolor: 'background.paper' }}>
        <Box
          component="nav"
          aria-label="连接器分组"
          sx={{
            width: 248,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            bgcolor: 'background.default',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            px: 1.5,
            py: 2.5
          }}
        >
          <Typography variant="h6" sx={{ px: 1.5, mb: 2, fontWeight: 700 }}>
            连接器
          </Typography>
          <List disablePadding sx={{ overflowY: 'auto', flex: 1 }}>
            <ListItemButton
              selected={group === '已配置' && page === 'list'}
              onClick={() => openGroup('已配置')}
              sx={{ borderRadius: 1.5, mb: 1 }}
            >
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                已配置 · {servers.length}
              </Typography>
            </ListItemButton>
            <Divider sx={{ my: 1.5 }} />
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ px: 1.5, mb: 1, display: 'block' }}
            >
              发现
            </Typography>
            {mcpConnectorCategories.map((category) => (
              <ListItemButton
                key={category}
                selected={group === category && page === 'list'}
                onClick={() => openGroup(category)}
                sx={{ borderRadius: 1.5, mb: 0.5 }}
              >
                <Typography variant="body2">
                  {category} ·{' '}
                  {featuredMcpConnectors.filter((entry) => entry.category === category).length}
                </Typography>
              </ListItemButton>
            ))}
          </List>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 3, pt: 2.5, pb: 2 }}>
            {page === 'list' ? (
              <Typography variant="h5" sx={{ fontWeight: 700, flex: 1 }}>
                {normalizedQuery ? '搜索结果' : group}
              </Typography>
            ) : (
              <>
                <Button onClick={() => openGroup(group)}>← 返回{group}</Button>
                <Box sx={{ flex: 1 }} />
              </>
            )}
            {page === 'list' && (
              <>
                <TextField
                  size="small"
                  placeholder="搜索连接器"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <PhiIcons.action.search fontSize="small" />
                        </InputAdornment>
                      )
                    }
                  }}
                  sx={{ width: { xs: 180, md: 260 } }}
                />
                <Button
                  variant="contained"
                  startIcon={<PhiIcons.action.add size={16} />}
                  onClick={() => setPage('custom')}
                >
                  添加
                </Button>
              </>
            )}
            <IconButton
              aria-label="关闭连接器目录"
              onClick={close}
              sx={{
                width: 36,
                height: 36,
                p: 0,
                flex: '0 0 36px',
                borderRadius: 1.5,
                '&:hover': { bgcolor: 'action.hover' }
              }}
            >
              <PhiIcons.action.close size={18} />
            </IconButton>
          </Stack>
          <Divider />
          <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 3 }}>
            {page === 'detail' && selected ? (
              <>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={2}
                  sx={{ alignItems: 'center', mb: 4 }}
                >
                  <ConnectorIcon connectorId={selected.id} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                      {selected.name}
                    </Typography>
                    <Typography color="text.secondary">{selected.description}</Typography>
                  </Box>
                  {selected.oauthAuthorizationOrigin ? (
                    <Stack direction="row" spacing={1}>
                      <Button
                        variant="contained"
                        disabled={busy !== null || selectedAuthStatus === 'checking'}
                        onClick={() => void connectOAuth(selected)}
                      >
                        {selectedAuthStatus === 'authenticated' ? '重新授权' : '授权登录'}
                      </Button>
                      {matchingServer(selected, servers)?.managed && (
                        <Button
                          color="error"
                          variant="outlined"
                          disabled={busy !== null}
                          onClick={() => void remove(matchingServer(selected, servers)!)}
                        >
                          移除
                        </Button>
                      )}
                    </Stack>
                  ) : matchingServer(selected, servers)?.managed ? (
                    <Button
                      color="error"
                      variant="outlined"
                      disabled={busy !== null}
                      onClick={() => void remove(matchingServer(selected, servers)!)}
                    >
                      移除
                    </Button>
                  ) : selected.signIn === '需要登录' && !matchingServer(selected, servers) ? (
                    <Button variant="outlined" disabled>
                      授权登录暂不可用
                    </Button>
                  ) : (
                    <Button
                      variant="contained"
                      disabled={Boolean(matchingServer(selected, servers)) || busy !== null}
                      onClick={() => void add(selected.id, selected.url)}
                    >
                      {matchingServer(selected, servers) ? '已配置' : '添加连接器'}
                    </Button>
                  )}
                </Stack>
                {selected.signIn === '需要登录' && !selected.oauthAuthorizationOrigin && (
                  <Alert severity="warning" sx={{ mb: 3 }}>
                    {selected.id === 'gmail'
                      ? 'Gmail MCP 需要先在 Google Cloud 启用服务并为 Phi 配置 OAuth 客户端。Phi 目前尚未提供该配置，暂不能从目录授权或添加。'
                      : selected.id === 'slack'
                        ? 'Slack MCP 需要预先注册 Slack 应用并配置 OAuth 客户端。Phi 目前尚未提供该流程，暂不能从目录授权或添加。'
                        : '此服务需要 OAuth 登录。Phi 尚未接入该授权流程，暂不能从目录添加使用。'}
                  </Alert>
                )}
                {selected.id === 'composio' && (
                  <Alert severity="info" sx={{ mb: 3 }}>
                    登录 Composio 后，可在使用具体应用时逐个授权。第三方账号由 Composio 管理。
                  </Alert>
                )}
                <McpToolList
                  requiresSignIn={
                    selected.signIn === '需要登录' && !selected.oauthAuthorizationOrigin
                  }
                  loading={toolsLoading}
                  names={toolNames}
                  error={toolsError}
                  onRetry={() => openDetail(selected, true)}
                />
                <Divider sx={{ mb: 3 }} />
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                    gap: 2
                  }}
                >
                  <Box>
                    <Typography variant="overline" color="text.secondary">
                      提供方
                    </Typography>
                    <Typography>{selected.publisher}</Typography>
                  </Box>
                  <Box>
                    <Typography variant="overline" color="text.secondary">
                      MCP 地址
                    </Typography>
                    <Typography sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
                      {selected.url}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="overline" color="text.secondary">
                      类别
                    </Typography>
                    <Typography>{selected.category}</Typography>
                  </Box>
                  <Box>
                    <Typography variant="overline" color="text.secondary">
                      登录
                    </Typography>
                    <Typography>
                      {selected.oauthAuthorizationOrigin && selectedAuthStatus === 'authenticated'
                        ? '已登录'
                        : selected.signIn}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="overline" color="text.secondary">
                      更多信息
                    </Typography>
                    <Button
                      component="a"
                      href={selected.homepageUrl}
                      target="_blank"
                      rel="noreferrer"
                      size="small"
                      sx={{ pl: 0 }}
                    >
                      连接器说明 ↗
                    </Button>
                  </Box>
                </Box>
              </>
            ) : page === 'custom' ? (
              <Stack spacing={2} sx={{ maxWidth: 620 }}>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                  添加自定义 MCP 连接器
                </Typography>
                <Alert severity="info">
                  这里仅保存服务地址。需要登录的服务仍需单独完成授权，保存配置不代表连接成功。
                </Alert>
                <TextField
                  label="名称"
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                  helperText="使用字母、数字、下划线或连字符"
                />
                <TextField
                  label="HTTPS MCP 地址"
                  value={customUrl}
                  onChange={(event) => setCustomUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                />
                <Button
                  variant="contained"
                  disabled={busy !== null || !customName.trim() || !customUrl.trim()}
                  onClick={() => void add(customName, customUrl)}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  保存 MCP 配置
                </Button>
              </Stack>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {group === '已配置'
                    ? '这里列出已保存的连接器；配置状态不代表服务端已经连通。'
                    : '按类别浏览常用 MCP 服务，已配置的连接器也会显示。'}
                </Typography>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                    gap: 1.5
                  }}
                >
                  {group === '已配置'
                    ? filteredInstalled.map(installedCard)
                    : filteredFeatured.map((connector) => connectorCard(connector))}
                </Box>
                {(group === '已配置' ? filteredInstalled : filteredFeatured).length === 0 && (
                  <Typography color="text.secondary" sx={{ mt: 2 }}>
                    {normalizedQuery ? '没有找到匹配的连接器' : '这个分组目前没有连接器'}
                  </Typography>
                )}
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mt: 2 }}
                >
                  无需登录的服务可直接添加；需要登录的服务须先授权。暂不支持授权的服务无法从目录添加。
                </Typography>
              </>
            )}
            {error && (
              <Alert severity="error" sx={{ mt: 3 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
          </Box>
        </Box>
      </Box>
    </Dialog>
  )
}
