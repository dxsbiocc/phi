import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  IconButton,
  List,
  ListItemButton,
  Stack,
  Typography
} from '@mui/material'
import {
  mcpConnectorCategories,
  type FeaturedMcpConnector,
  type RemoteMcpConnectorOptions
} from '../../../../../shared/mcpConnectorCatalog'
import type { PackageUpdateView } from '../../../../../shared/packageManagerTypes'
import { PhiIcons } from '../../../icons'
import { loadContentCatalog } from '../../../lib/contentCatalog'
import type { McpServerSummary } from '../../../types'
import { featuredAuthFailureNotice, featuredOAuthStatusFromError } from '../lib/featuredAuthStatus'
import {
  filterFeaturedConnectors,
  type ConnectorInstallFilter,
  type ConnectorSignInFilter,
  type ConnectorSort
} from '../lib/featuredConnectorFilters'
import {
  cacheFeaturedToolNames,
  cachedFeaturedToolNames,
  clearFeaturedToolNames
} from '../lib/featuredToolCache'
import { McpApiKeyDialog } from './McpApiKeyDialog'
import { McpConnectorCatalogToolbar } from './McpConnectorCatalogToolbar'
import { McpCustomConnectorDialog } from './McpCustomConnectorDialog'
import { McpFeaturedConnectorCard, type ConnectorAuthStatus } from './McpFeaturedConnectorCard'
import { McpFeaturedConnectorDetails } from './McpFeaturedConnectorDetails'

type CatalogPage = 'list' | 'detail'
type CatalogGroup = (typeof mcpConnectorCategories)[number]

function ipcErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+': (?:[^:]+: )?/, '')
}

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
    (server) =>
      server.packageId === connector.id ||
      server.connectorId === connector.id ||
      (connector.url !== undefined &&
        server.url === connector.url &&
        (!connector.apiKey || server.name === connector.id))
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
  const [signInFilter, setSignInFilter] = useState<ConnectorSignInFilter>('all')
  const [installFilter, setInstallFilter] = useState<ConnectorInstallFilter>('all')
  const [sort, setSort] = useState<ConnectorSort>('default')
  const [customOpen, setCustomOpen] = useState(false)
  const [customError, setCustomError] = useState<string | null>(null)
  const [customAuthorizingName, setCustomAuthorizingName] = useState<string | null>(null)
  const savedCustomAuthRef = useRef<{
    name: string
    url: string
    oauth: RemoteMcpConnectorOptions['oauth'] | null
  } | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyDialogId, setApiKeyDialogId] = useState<string | null>(null)
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [authorizingId, setAuthorizingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceNotice, setSourceNotice] = useState<string | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [toolNames, setToolNames] = useState<string[] | null>(null)
  const [toolsLoading, setToolsLoading] = useState(false)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [authStatusById, setAuthStatusById] = useState<Record<string, ConnectorAuthStatus>>({})
  const toolRequestRef = useRef(0)

  useEffect(() => {
    if (!open) return
    let active = true
    void Promise.resolve().then(() => {
      if (active) setCatalogLoading(true)
    })
    void Promise.all([
      window.api.listMcpConnectorCatalog(),
      window.api.listPackageUpdates().catch(() => []),
      loadContentCatalog(window.api)
    ])
      .then(([entries, availableUpdates, catalog]) => {
        if (!active) return
        setConnectors(entries)
        setUpdates(availableUpdates)
        setSourceError(catalog.errors.join('\n') || null)
        setSourceNotice(catalog.notices.join('\n') || '首选来源：Phi Packages')
        for (const connector of entries.filter(
          (entry) => entry.oauthAuthorizationOrigin || entry.apiKey
        )) {
          const cachedTools = cachedFeaturedToolNames(connector.id)
          const status = connector.apiKey
            ? typeof window.api.getFeaturedMcpApiKeyStatus === 'function'
              ? window.api.getFeaturedMcpApiKeyStatus(connector.id)
              : Promise.reject(new Error('本地密钥接口尚未加载'))
            : typeof window.api.getFeaturedMcpAuthStatus === 'function'
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
              const message = ipcErrorMessage(cause)
              setAuthStatusById((current) => ({
                ...current,
                [connector.id]: connector.oauthAuthorizationOrigin
                  ? featuredOAuthStatusFromError(message, connector.name)
                  : 'unavailable'
              }))
            })
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(ipcErrorMessage(cause))
      })
      .finally(() => {
        if (active) setCatalogLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, servers])
  const selected = connectors.find((connector) => connector.id === selectedId)
  const apiKeyDialogConnector =
    connectors.find((connector) => connector.id === apiKeyDialogId && connector.apiKey) ?? null
  const selectedAuthStatus = authStatusById[selectedId] ?? 'checking'
  const normalizedQuery = query.trim().toLowerCase()
  const filteredFeatured = useMemo(
    () =>
      filterFeaturedConnectors(connectors, {
        category: group,
        query,
        signIn: signInFilter,
        install: installFilter,
        sort,
        isInstalled: (connector) => connector.added || Boolean(matchingServer(connector, servers))
      }),
    [connectors, group, installFilter, query, servers, signInFilter, sort]
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

  async function setConnectorEnabled(server: McpServerSummary, enabled: boolean): Promise<void> {
    setBusy(server.name)
    setError(null)
    try {
      await window.api.setMcpConnectorEnabled(server.name, enabled, server.sourcePath)
      await onRefresh()
      await refreshCatalog()
    } catch (cause) {
      setError(ipcErrorMessage(cause))
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
      if (connector) clearFeaturedToolNames(connector.id)
      if (connector?.apiKey) {
        await window.api.clearFeaturedMcpApiKey(connector.id)
        toolRequestRef.current += 1
        setToolNames(null)
        setToolsError(null)
        setToolsLoading(false)
        setAuthStatusById((current) => ({ ...current, [connector.id]: 'unauthenticated' }))
      }
      await onRefresh()
      await refreshCatalog()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function refreshOAuthStatus(connector: FeaturedMcpConnector): Promise<void> {
    try {
      const authenticated = await window.api.getFeaturedMcpAuthStatus(connector.id)
      setAuthStatusById((current) => ({
        ...current,
        [connector.id]: authenticated ? 'authenticated' : 'unauthenticated'
      }))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setAuthStatusById((current) => ({
        ...current,
        [connector.id]: featuredOAuthStatusFromError(message, connector.name)
      }))
    }
  }

  async function connectOAuth(connector: FeaturedMcpConnector): Promise<void> {
    if (!connector.oauthAuthorizationOrigin || authorizingId) return
    if (typeof window.api.authorizeFeaturedMcp !== 'function') {
      setError('授权接口尚未加载，请重启 Phi 后重试')
      return
    }
    toolRequestRef.current += 1
    setAuthorizingId(connector.id)
    setAuthStatusById((current) => ({ ...current, [connector.id]: 'unauthenticated' }))
    setError(null)
    setToolsError(null)
    setToolsLoading(false)
    try {
      await window.api.authorizeFeaturedMcp(connector.id)
      setAuthStatusById((current) => ({ ...current, [connector.id]: 'authenticated' }))
      clearFeaturedToolNames(connector.id)
      if (!matchingServer(connector, servers)) {
        await window.api.installMcpConnector(connector.id, connector.version, connector.registryDir)
        await onRefresh()
        await refreshCatalog()
      }
      const names = await window.api.listFeaturedMcpTools(connector.id)
      cacheFeaturedToolNames(connector.id, names)
      setToolNames(names)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await refreshOAuthStatus(connector)
      setError(featuredAuthFailureNotice(message))
    } finally {
      setAuthorizingId((current) => (current === connector.id ? null : current))
    }
  }

  function cancelOAuth(connector: FeaturedMcpConnector): void {
    if (typeof window.api.cancelFeaturedMcpAuth === 'function') {
      void window.api.cancelFeaturedMcpAuth(connector.id)
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
        await window.api.installMcpConnector(connector.id, connector.version, connector.registryDir)
        await onRefresh()
        await refreshCatalog()
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
      ((connector.apiKey || connector.oauthAuthorizationOrigin) &&
        authStatusById[connector.id] !== 'authenticated')
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
          const message = ipcErrorMessage(cause)
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
    if (customAuthorizingName) {
      void window.api.cancelRemoteMcpAuth(customAuthorizingName)
    }
    if (authorizingId && typeof window.api.cancelFeaturedMcpAuth === 'function') {
      void window.api.cancelFeaturedMcpAuth(authorizingId)
    }
    toolRequestRef.current += 1
    setAuthStatusById({})
    setApiKeyInput('')
    setApiKeyDialogId(null)
    setApiKeyError(null)
    setCustomOpen(false)
    savedCustomAuthRef.current = null
    setCustomError(null)
    setCustomAuthorizingName(null)
    setSignInFilter('all')
    setInstallFilter('all')
    setSort('default')
    setPage('list')
    setCatalogLoading(true)
    onClose()
  }

  async function addCustom(
    name: string,
    url: string,
    options?: RemoteMcpConnectorOptions
  ): Promise<void> {
    setBusy(name)
    setCustomError(null)
    try {
      const previous = savedCustomAuthRef.current
      const retryOptions =
        previous?.name === name && previous.url === url
          ? { ...options, expectedOAuth: previous.oauth }
          : options
      await window.api.addRemoteMcpConnector(name, url, retryOptions)
      savedCustomAuthRef.current = { name, url, oauth: options?.oauth ?? null }
      await onRefresh()
      if (options?.oauth?.clientId) {
        setCustomAuthorizingName(name)
        await window.api.authorizeRemoteMcpConnector(name)
        for (const connector of connectors.filter(
          (entry) => entry.url === url && entry.oauthAuthorizationOrigin
        )) {
          clearFeaturedToolNames(connector.id)
          await refreshOAuthStatus(connector)
        }
      }
      await refreshCatalog()
      savedCustomAuthRef.current = null
      setCustomOpen(false)
    } catch (cause) {
      setCustomError(featuredAuthFailureNotice(ipcErrorMessage(cause)))
    } finally {
      setCustomAuthorizingName(null)
      setBusy(null)
    }
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
    const server = matchingServer(connector, servers)
    const updateAvailable = updates.some(
      (update) => update.type === 'mcp' && update.id === connector.id
    )
    return (
      <McpFeaturedConnectorCard
        key={key}
        connector={connector}
        installed={connector.added || Boolean(server)}
        enabled={server?.enabled !== false}
        updateAvailable={updateAvailable}
        authStatus={authStatusById[connector.id] ?? 'checking'}
        busy={busy !== null}
        authorizing={authorizingId === connector.id}
        onOpen={() => openDetail(connector)}
        onCancel={() => cancelOAuth(connector)}
        onAdd={() =>
          connector.apiKey ? openApiKeyDialog(connector) : void addConnector(connector)
        }
        onAuthorize={() =>
          connector.apiKey ? openApiKeyDialog(connector) : void connectOAuth(connector)
        }
        onBuildEnvironment={() => void buildEnvironment(connector)}
        onEnable={server ? () => void setConnectorEnabled(server, true) : undefined}
      />
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
            overflow: 'hidden',
            WebkitAppRegion: 'no-drag'
          }
        }
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '248px minmax(0, 1fr)',
          gridTemplateRows: 'auto minmax(0, 1fr)',
          height: '100%',
          minHeight: 0,
          bgcolor: 'background.paper'
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            px: 3,
            borderRight: 1,
            borderColor: 'divider',
            bgcolor: 'background.default'
          }}
        >
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            连接器
          </Typography>
        </Box>
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
            <Button
              variant="contained"
              startIcon={<PhiIcons.action.add size={16} />}
              onClick={() => {
                savedCustomAuthRef.current = null
                setCustomError(null)
                setCustomOpen(true)
              }}
            >
              添加
            </Button>
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
        <Box
          component="nav"
          aria-label="连接器分组"
          sx={{
            minHeight: 0,
            overflowY: 'auto',
            px: 1.5,
            borderRight: 1,
            borderColor: 'divider',
            bgcolor: 'background.default'
          }}
        >
          <List disablePadding>
            {mcpConnectorCategories
              .map((category) => ({
                category,
                count: connectors.filter((entry) => entry.category === category).length
              }))
              .filter(({ count }) => count > 0)
              .map(({ category, count }) => (
                <ListItemButton
                  key={category}
                  selected={group === category && page === 'list'}
                  onClick={() => openGroup(category)}
                  sx={{ borderRadius: 1.5, mb: 0.5 }}
                >
                  <Typography variant="body2">
                    {category} · {count}
                  </Typography>
                </ListItemButton>
              ))}
          </List>
        </Box>
        <Box sx={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 3 }}>
            {sourceError ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                {sourceError}
              </Alert>
            ) : null}
            {sourceNotice ? (
              <Alert severity="info" sx={{ mb: 2 }}>
                {sourceNotice}
              </Alert>
            ) : null}
            {page === 'detail' && selected ? (
              <McpFeaturedConnectorDetails
                connector={selected}
                server={matchingServer(selected, servers)}
                authStatus={selectedAuthStatus}
                busy={busy !== null}
                authorizing={authorizingId === selected.id}
                updateAvailable={updates.some(
                  (update) => update.type === 'mcp' && update.id === selected.id
                )}
                onCancelAuthorize={() => cancelOAuth(selected)}
                toolNames={toolNames}
                toolsLoading={toolsLoading}
                toolsError={toolsError}
                onAdd={() => void addConnector(selected)}
                onRemove={() => {
                  const server = matchingServer(selected, servers)
                  if (server) void remove(server)
                }}
                onAuthorize={() => void connectOAuth(selected)}
                onApiKey={() => openApiKeyDialog(selected)}
                onBuildEnvironment={() => void buildEnvironment(selected)}
                onEnabledChange={(enabled) => {
                  const server = matchingServer(selected, servers)
                  if (server) void setConnectorEnabled(server, enabled)
                }}
                onRetry={() => openDetail(selected, true)}
              />
            ) : (
              <>
                {catalogLoading && <Typography color="text.secondary">正在加载连接器…</Typography>}
                <McpConnectorCatalogToolbar
                  query={query}
                  signIn={signInFilter}
                  install={installFilter}
                  sort={sort}
                  onQueryChange={setQuery}
                  onSignInChange={setSignInFilter}
                  onInstallChange={setInstallFilter}
                  onSortChange={setSort}
                />
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                    gap: 1.5
                  }}
                >
                  {!catalogLoading && filteredFeatured.map((connector) => connectorCard(connector))}
                </Box>
                {!catalogLoading && filteredFeatured.length === 0 && (
                  <Typography color="text.secondary" sx={{ mt: 2 }}>
                    {normalizedQuery || signInFilter !== 'all' || installFilter !== 'all'
                      ? '没有符合条件的连接器'
                      : '这个分组目前没有连接器'}
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
      {customOpen && (
        <McpCustomConnectorDialog
          open
          busy={busy !== null}
          authorizing={customAuthorizingName !== null}
          error={customError}
          onClose={() => {
            if (customAuthorizingName) {
              void window.api.cancelRemoteMcpAuth(customAuthorizingName).catch((cause: unknown) => {
                setCustomError(ipcErrorMessage(cause))
              })
              return
            }
            if (busy !== null) return
            savedCustomAuthRef.current = null
            setCustomOpen(false)
            setCustomError(null)
          }}
          onSubmit={(name, url, options) => void addCustom(name, url, options)}
        />
      )}
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
