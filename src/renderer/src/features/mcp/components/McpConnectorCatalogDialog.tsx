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
  mcpConnectorCategories,
  type FeaturedMcpConnector
} from '../../../../../shared/mcpConnectorCatalog'
import type { PackageUpdateView } from '../../../../../shared/packageManagerTypes'
import { PhiIcons } from '../../../icons'
import type { McpServerSummary } from '../../../types'
import { ConnectorIcon } from './ConnectorIcon'
import { McpFeaturedConnectorCard, type ConnectorAuthStatus } from './McpFeaturedConnectorCard'
import { McpToolList } from './McpToolList'

type CatalogPage = 'list' | 'detail' | 'custom'
type CatalogGroup = '已安装' | (typeof mcpConnectorCategories)[number]
const TOOL_LIST_CACHE_MS = 5 * 60_000
type CachedToolNames = { names: string[]; expiresAt: number }

function freshTools(entry: CachedToolNames | undefined): entry is CachedToolNames {
  return Boolean(entry && entry.expiresAt > Date.now())
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
    (server) =>
      server.packageId === connector.id ||
      server.connectorId === connector.id ||
      (connector.url !== undefined && server.url === connector.url)
  )
}

export function McpConnectorCatalogDialog({
  open,
  servers,
  onClose,
  onRefresh
}: McpConnectorCatalogDialogProps): React.JSX.Element {
  const [page, setPage] = useState<CatalogPage>('list')
  const [connectors, setConnectors] = useState<FeaturedMcpConnector[]>([])
  const [updates, setUpdates] = useState<PackageUpdateView[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
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
  const [notionAuthStatus, setNotionAuthStatus] = useState<ConnectorAuthStatus>('checking')
  const toolRequestRef = useRef(0)
  const toolListCacheRef = useRef(new Map<string, CachedToolNames>())

  useEffect(() => {
    if (!open) return
    let active = true
    void Promise.all([window.api.listMcpConnectorCatalog(), window.api.listPackageUpdates()])
      .then(([entries, availableUpdates]) => {
        if (active) {
          setConnectors(entries)
          setUpdates(availableUpdates)
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setCatalogLoading(false)
      })
    const cachedNotionTools = toolListCacheRef.current.get('notion')
    const status =
      typeof window.api.getFeaturedMcpAuthStatus === 'function'
        ? window.api.getFeaturedMcpAuthStatus('notion')
        : freshTools(cachedNotionTools)
          ? Promise.resolve(true)
          : window.api.listFeaturedMcpTools('notion').then((names) => {
              toolListCacheRef.current.set('notion', {
                names,
                expiresAt: Date.now() + TOOL_LIST_CACHE_MS
              })
              return true
            })
    void status
      .then((authenticated) => {
        if (active) setNotionAuthStatus(authenticated ? 'authenticated' : 'unauthenticated')
      })
      .catch((cause: unknown) => {
        if (!active) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setNotionAuthStatus(
          message.includes('请先授权登录 Notion') ? 'unauthenticated' : 'unavailable'
        )
      })
    return () => {
      active = false
    }
  }, [open])
  const selected = connectors.find((connector) => connector.id === selectedId)
  const selectedUpdateAvailable = selected
    ? updates.some((update) => update.type === 'mcp' && update.id === selected.id)
    : false
  const normalizedQuery = query.trim().toLowerCase()
  const filteredFeatured = useMemo(
    () =>
      connectors.filter(
        (connector) =>
          (normalizedQuery.length > 0 || connector.category === group) &&
          (!normalizedQuery ||
            [connector.name, connector.description, connector.category, connector.publisher].some(
              (value) => value.toLowerCase().includes(normalizedQuery)
            ))
      ),
    [connectors, group, normalizedQuery]
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

  async function refreshCatalog(): Promise<void> {
    const [nextConnectors, nextUpdates] = await Promise.all([
      window.api.listMcpConnectorCatalog(),
      window.api.listPackageUpdates()
    ])
    setConnectors(nextConnectors)
    setUpdates(nextUpdates)
  }

  async function addConnector(connector: FeaturedMcpConnector): Promise<void> {
    setBusy(connector.id)
    setError(null)
    try {
      await window.api.installMcpConnector(connector.id, connector.version, connector.registryDir)
      await onRefresh()
      await refreshCatalog()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function addCustom(): Promise<void> {
    setBusy(customName)
    setError(null)
    try {
      await window.api.addRemoteMcpConnector(customName, customUrl)
      await onRefresh()
      setCustomName('')
      setCustomUrl('')
      setGroup('已安装')
      setPage('list')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function buildEnvironment(connector: FeaturedMcpConnector): Promise<void> {
    setBusy(connector.id)
    setError(null)
    try {
      await window.api.buildMcpConnectorEnvironment(connector.id)
      await onRefresh()
      await refreshCatalog()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function remove(server: McpServerSummary): Promise<void> {
    if (!server.packageId && !server.url) return
    setBusy(server.name)
    setError(null)
    try {
      if (server.packageId) await window.api.uninstallMcpConnector(server.packageId)
      else if (server.url) await window.api.removeRemoteMcpConnector(server.name, server.url)
      const connector = connectors.find(
        (entry) => entry.id === server.packageId || entry.url === server.url
      )
      if (connector) toolListCacheRef.current.delete(connector.id)
      await onRefresh()
      await refreshCatalog()
      setPage('list')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function connectNotion(): Promise<void> {
    const notion = connectors.find((connector) => connector.id === 'notion')
    if (!notion) return
    if (typeof window.api.authorizeFeaturedMcp !== 'function') {
      setError('授权接口尚未加载，请重启 Phi 后重试')
      return
    }
    toolRequestRef.current += 1
    setBusy(notion.id)
    setError(null)
    setToolsError(null)
    setToolsLoading(false)
    try {
      await window.api.authorizeFeaturedMcp(notion.id)
      setNotionAuthStatus('authenticated')
      toolListCacheRef.current.delete(notion.id)
      if (!matchingServer(notion, servers)) {
        await window.api.installMcpConnector(notion.id, notion.version, notion.registryDir)
        await onRefresh()
        await refreshCatalog()
      }
      const names = await window.api.listFeaturedMcpTools(notion.id)
      toolListCacheRef.current.set(notion.id, {
        names,
        expiresAt: Date.now() + TOOL_LIST_CACHE_MS
      })
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
    if (connector.signIn === '需要登录' && connector.id !== 'notion') {
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
          toolListCacheRef.current.set(connector.id, {
            names,
            expiresAt: Date.now() + TOOL_LIST_CACHE_MS
          })
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
    setNotionAuthStatus('checking')
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
    const updateAvailable = updates.some(
      (update) => update.type === 'mcp' && update.id === connector.id
    )
    return (
      <McpFeaturedConnectorCard
        key={key}
        connector={connector}
        installed={connector.added || Boolean(matchingServer(connector, servers))}
        updateAvailable={updateAvailable}
        authStatus={notionAuthStatus}
        busy={busy !== null}
        onOpen={() => openDetail(connector)}
        onAdd={() => void addConnector(connector)}
        onBuildEnvironment={() => void buildEnvironment(connector)}
      />
    )
  }

  function installedCard(server: McpServerSummary): React.JSX.Element {
    const connector = connectors.find(
      (entry) => entry.id === server.packageId || entry.url === server.url
    )
    if (connector) return connectorCard(connector, server.id)
    return (
      <Box
        key={server.id}
        sx={{ p: 1.75, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}
      >
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <ConnectorIcon connectorId={server.connectorId ?? server.packageId} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 700 }}>{server.name}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {server.url ?? server.command ?? '本地 MCP 服务'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {server.enabled === false ? '已停用' : '已配置'}
            </Typography>
          </Box>
          {server.managed && (server.packageId || server.url) && (
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
              selected={group === '已安装' && page === 'list'}
              onClick={() => openGroup('已安装')}
              sx={{ borderRadius: 1.5, mb: 1 }}
            >
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                已安装 · {servers.length}
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
                  {category} · {connectors.filter((entry) => entry.category === category).length}
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
                  {selected.id === 'notion' ? (
                    <Stack direction="row" spacing={1}>
                      <Button
                        variant="contained"
                        disabled={busy !== null || notionAuthStatus === 'checking'}
                        onClick={() => void connectNotion()}
                      >
                        {notionAuthStatus === 'authenticated' ? '重新授权' : '授权登录'}
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
                  ) : selectedUpdateAvailable ? (
                    <Button
                      variant="contained"
                      disabled={busy !== null}
                      onClick={() => void addConnector(selected)}
                    >
                      更新
                    </Button>
                  ) : matchingServer(selected, servers)?.managed ? (
                    <Button
                      color="error"
                      variant="outlined"
                      disabled={busy !== null}
                      onClick={() => void remove(matchingServer(selected, servers)!)}
                    >
                      移除
                    </Button>
                  ) : selected.unavailableReason ? (
                    <Button variant="outlined" disabled>
                      需要新版 Phi
                    </Button>
                  ) : selected.environmentState === 'not-built' ? (
                    <Button
                      variant="contained"
                      disabled={busy !== null}
                      onClick={() => void buildEnvironment(selected)}
                    >
                      构建环境
                    </Button>
                  ) : selected.signIn === '需要登录' && !matchingServer(selected, servers) ? (
                    <Button variant="outlined" disabled>
                      授权登录暂不可用
                    </Button>
                  ) : (
                    <Button
                      variant="contained"
                      disabled={Boolean(matchingServer(selected, servers)) || busy !== null}
                      onClick={() => void addConnector(selected)}
                    >
                      {matchingServer(selected, servers) ? '已配置' : '添加连接器'}
                    </Button>
                  )}
                </Stack>
                {selected.signIn === '需要登录' && selected.id !== 'notion' && (
                  <Alert severity="info" sx={{ mb: 3 }}>
                    此服务需要 OAuth 登录。Phi 尚未接入该授权流程，暂不能从目录添加使用。
                  </Alert>
                )}
                <McpToolList
                  requiresSignIn={selected.signIn === '需要登录' && selected.id !== 'notion'}
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
                      {selected.url ?? [selected.command, ...(selected.args ?? [])].join(' ')}
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
                      {selected.id === 'notion' && notionAuthStatus === 'authenticated'
                        ? '已登录'
                        : selected.signIn}
                    </Typography>
                  </Box>
                  {selected.homepageUrl && (
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
                        官方连接器页面 ↗
                      </Button>
                    </Box>
                  )}
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
                  onClick={() => void addCustom()}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  保存 MCP 配置
                </Button>
              </Stack>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {group === '已安装'
                    ? '这里列出已保存的连接器；配置状态不代表服务端已经连通。'
                    : '按类别浏览常用 MCP 服务，已添加的连接器也会显示。'}
                </Typography>
                {catalogLoading && <Typography color="text.secondary">正在加载连接器…</Typography>}
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                    gap: 1.5
                  }}
                >
                  {!catalogLoading &&
                    (group === '已安装'
                      ? filteredInstalled.map(installedCard)
                      : filteredFeatured.map((connector) => connectorCard(connector)))}
                </Box>
                {!catalogLoading &&
                  (group === '已安装' ? filteredInstalled : filteredFeatured).length === 0 && (
                    <Typography color="text.secondary" sx={{ mt: 2 }}>
                      {normalizedQuery ? '没有找到匹配的连接器' : '这个分组目前没有连接器'}
                    </Typography>
                  )}
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mt: 2 }}
                >
                  添加会保存全局 MCP 配置；新建本地会话时加载。需要登录的服务还需完成授权。
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
