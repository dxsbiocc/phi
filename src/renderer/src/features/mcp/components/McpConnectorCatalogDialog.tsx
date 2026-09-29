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
import {
  cacheFeaturedToolNames,
  cachedFeaturedToolNames,
  clearFeaturedToolNames
} from '../lib/featuredToolCache'
import { ConnectorIcon } from './ConnectorIcon'
import { McpApiKeyDialog } from './McpApiKeyDialog'
import { McpFeaturedConnectorCard, type ConnectorAuthStatus } from './McpFeaturedConnectorCard'
import { McpFeaturedConnectorDetails } from './McpFeaturedConnectorDetails'

type CatalogPage = 'list' | 'detail' | 'custom'
type CatalogGroup = '已配置' | (typeof mcpConnectorCategories)[number]
const authConnectors = featuredMcpConnectors.filter(
  (connector) => connector.oauthAuthorizationOrigin || connector.apiKey
)

function apiKeyErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(
    /^Error invoking remote method ['"]mcp:setFeaturedApiKey['"]: (?:McpApiKeyValidationError|Error): /,
    ''
  )
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
  return servers.find(
    (server) => server.url === connector.url && (!connector.apiKey || server.name === connector.id)
  )
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
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyDialogId, setApiKeyDialogId] = useState<string | null>(null)
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toolNames, setToolNames] = useState<string[] | null>(null)
  const [toolsLoading, setToolsLoading] = useState(false)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [authStatusById, setAuthStatusById] = useState<Record<string, ConnectorAuthStatus>>({})
  const toolRequestRef = useRef(0)

  useEffect(() => {
    if (!open) return
    let active = true
    for (const connector of authConnectors) {
      const cachedTools = cachedFeaturedToolNames(connector.id)
      const status = connector.apiKey
        ? typeof window.api.getFeaturedMcpApiKeyStatus === 'function'
          ? window.api.getFeaturedMcpApiKeyStatus(connector.id)
          : Promise.reject(new Error('本地密钥接口尚未加载'))
        : connector.oauthAuthorizationOrigin &&
            typeof window.api.getFeaturedMcpAuthStatus === 'function'
          ? window.api.getFeaturedMcpAuthStatus(connector.id)
          : cachedTools !== null
            ? Promise.resolve(true)
            : window.api.listFeaturedMcpTools(connector.id).then((names) => {
                cacheFeaturedToolNames(connector.id, names)
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
  const apiKeyDialogConnector =
    featuredMcpConnectors.find(
      (connector) => connector.id === apiKeyDialogId && connector.apiKey
    ) ?? null
  const selectedAuthStatus = authStatusById[selectedId] ?? 'checking'
  const normalizedQuery = query.trim().toLowerCase()
  const filteredFeatured = useMemo(
    () =>
      featuredMcpConnectors.filter(
        (connector) =>
          (normalizedQuery.length > 0 || connector.category === group) &&
          (!normalizedQuery ||
            [
              connector.name,
              connector.description,
              connector.overview,
              connector.category,
              connector.publisher
            ].some((value) => value.toLowerCase().includes(normalizedQuery)))
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
      const connector = featuredMcpConnectors.find(
        (entry) => entry.url === server.url && (!entry.apiKey || entry.id === server.name)
      )
      if (connector) clearFeaturedToolNames(connector.id)
      if (connector?.apiKey) {
        toolRequestRef.current += 1
        setToolNames(null)
        setToolsError(null)
        setToolsLoading(false)
        setAuthStatusById((current) => ({ ...current, [connector.id]: 'unauthenticated' }))
      }
      await onRefresh()
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
      clearFeaturedToolNames(connector.id)
      if (!matchingServer(connector, servers)) {
        await window.api.addRemoteMcpConnector(connector.id, connector.url)
        await onRefresh()
      }
      const names = await window.api.listFeaturedMcpTools(connector.id)
      cacheFeaturedToolNames(connector.id, names)
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

  function openApiKeyDialog(connector: FeaturedMcpConnector): void {
    setApiKeyDialogId(connector.id)
    setApiKeyInput('')
    setApiKeyError(null)
  }

  function closeApiKeyDialog(): void {
    setApiKeyDialogId(null)
    setApiKeyInput('')
    setApiKeyError(null)
  }

  async function connectApiKey(connector: FeaturedMcpConnector): Promise<void> {
    if (!connector.apiKey) return
    const key = apiKeyInput.trim()
    if (!key && authStatusById[connector.id] !== 'authenticated') return
    setBusy(connector.id)
    setApiKeyError(null)
    setToolsError(null)
    try {
      if (key) {
        await window.api.setFeaturedMcpApiKey(connector.id, key)
        setApiKeyInput('')
        setAuthStatusById((current) => ({ ...current, [connector.id]: 'authenticated' }))
      }
      clearFeaturedToolNames(connector.id)
      if (!matchingServer(connector, servers)) {
        await window.api.addRemoteMcpConnector(connector.id, connector.url)
        await onRefresh()
      }
      closeApiKeyDialog()
      const request = ++toolRequestRef.current
      try {
        const names = await window.api.listFeaturedMcpTools(connector.id)
        cacheFeaturedToolNames(connector.id, names)
        if (
          request === toolRequestRef.current &&
          page === 'detail' &&
          selectedId === connector.id
        ) {
          setToolNames(names)
        }
      } catch (cause) {
        if (
          request === toolRequestRef.current &&
          page === 'detail' &&
          selectedId === connector.id
        ) {
          setToolsError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    } catch (cause) {
      setApiKeyError(apiKeyErrorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  function openDetail(connector: FeaturedMcpConnector, refresh = false): void {
    setSelectedId(connector.id)
    setApiKeyInput('')
    setPage('detail')
    setError(null)
    setToolNames(null)
    setToolsError(null)
    const request = ++toolRequestRef.current
    if (
      (connector.signIn === '需要登录' && !connector.oauthAuthorizationOrigin) ||
      (connector.apiKey && authStatusById[connector.id] !== 'authenticated')
    ) {
      setToolsLoading(false)
      return
    }
    if (refresh) clearFeaturedToolNames(connector.id)
    const cached = cachedFeaturedToolNames(connector.id)
    if (cached !== null) {
      setToolNames(cached)
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
          cacheFeaturedToolNames(connector.id, names)
          setToolNames(names)
        }
      })
      .catch((cause: unknown) => {
        if (request === toolRequestRef.current) {
          const message = cause instanceof Error ? cause.message : String(cause)
          const staleCatalog =
            connector.signIn === '无需登录' &&
            message.includes('该连接器需要授权，暂无法读取实际工具列表')
          setToolsError(
            staleCatalog
              ? '运行时尚未加载新连接器，请重启 Phi 后重试'
              : /No handler registered for ['"]mcp:featuredTools['"]/.test(message)
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
    setApiKeyInput('')
    setApiKeyDialogId(null)
    setApiKeyError(null)
    setPage('list')
    onClose()
  }

  function openGroup(nextGroup: CatalogGroup): void {
    toolRequestRef.current += 1
    setGroup(nextGroup)
    setPage('list')
    setQuery('')
    setError(null)
    setApiKeyInput('')
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
        onAdd={() =>
          connector.apiKey ? openApiKeyDialog(connector) : void add(connector.id, connector.url)
        }
        onAuthorize={() =>
          connector.apiKey ? openApiKeyDialog(connector) : void connectOAuth(connector)
        }
      />
    )
  }

  function installedCard(server: McpServerSummary): React.JSX.Element {
    const connector = featuredMcpConnectors.find(
      (entry) => entry.url === server.url && (!entry.apiKey || entry.id === server.name)
    )
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
              <McpFeaturedConnectorDetails
                connector={selected}
                server={matchingServer(selected, servers)}
                authStatus={selectedAuthStatus}
                busy={busy !== null}
                toolNames={toolNames}
                toolsLoading={toolsLoading}
                toolsError={toolsError}
                onAdd={() => void add(selected.id, selected.url)}
                onRemove={() => {
                  const server = matchingServer(selected, servers)
                  if (server) void remove(server)
                }}
                onAuthorize={() => void connectOAuth(selected)}
                onApiKey={() => openApiKeyDialog(selected)}
                onRetry={() => openDetail(selected, true)}
              />
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
      <McpApiKeyDialog
        connector={apiKeyDialogConnector}
        value={apiKeyInput}
        verified={
          apiKeyDialogConnector
            ? authStatusById[apiKeyDialogConnector.id] === 'authenticated'
            : false
        }
        installed={
          apiKeyDialogConnector ? Boolean(matchingServer(apiKeyDialogConnector, servers)) : false
        }
        busy={busy !== null}
        error={apiKeyError ? apiKeyErrorMessage(apiKeyError) : null}
        onChange={setApiKeyInput}
        onClose={closeApiKeyDialog}
        onSubmit={() => {
          if (apiKeyDialogConnector) void connectApiKey(apiKeyDialogConnector)
        }}
      />
    </Dialog>
  )
}
