import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { Box, Divider, InputAdornment, List, Stack, TextField, Typography } from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { PhiIcons } from '../../icons'
import type { McpServerSummary } from '../../types'
import { mcpConnectorCategories } from '../../../../shared/mcpConnectorCatalog'
import { McpConnectorCatalogDialog } from './components/McpConnectorCatalogDialog'
import { McpEnableSwitch } from './components/McpEnableSwitch'
import { ConnectorIcon } from './components/ConnectorIcon'
import { McpDetailPanel as McpDetail, type McpDetailPanelProps } from './components/McpDetailPanel'
import { SidebarAccordionGroup } from '../../components/SidebarAccordionGroup'
import { DiscoverButton } from '../../components/DiscoverButton'
import {
  createTrustedDialogRequestCoordinator,
  type TrustedOverlayRequest
} from '../../lib/trustedOverlayRequests'

const SearchIcon = PhiIcons.action.search

type SidebarWidth = number | string

export type McpViewProps = {
  servers: McpServerSummary[]
  activeServerId: string | null
  sidebarWidth: number
  onSelectServer: (id: string) => void
  onStartSidebarResize: (event: MouseEvent<HTMLDivElement>) => void
}

export type McpSidebarProps = {
  servers: McpServerSummary[]
  activeServerId: string | null
  sidebarWidth?: SidebarWidth
  onSelectServer: (server: McpServerSummary) => void
  onRefreshServers?: () => Promise<void>
  requestTrustedOverlay?: TrustedOverlayRequest
  cancelTrustedOverlay?: (key: string) => void
  onPreviewInteractionChange?: (active: boolean) => void
}

export type McpDetailProps = McpDetailPanelProps

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44
const contentTopGap = 8
const plainSidebarRowSx = {
  alignItems: 'flex-start',
  mx: 1,
  my: 0.5,
  px: 1.5,
  py: 1.25,
  borderRadius: 1.5,
  border: '1px solid transparent',
  backgroundColor: 'transparent',
  transition: 'none',
  '&:hover': {
    backgroundColor: (theme: Theme) => alpha(theme.palette.primary.main, 0.09),
    borderColor: (theme: Theme) => alpha(theme.palette.primary.main, 0.2)
  },
  '&.Mui-selected': {
    backgroundColor: (theme: Theme) => alpha(theme.palette.primary.main, 0.13),
    borderColor: (theme: Theme) => alpha(theme.palette.primary.main, 0.38)
  },
  '&.Mui-selected:hover': {
    backgroundColor: (theme: Theme) => alpha(theme.palette.primary.main, 0.17)
  },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
} as const

function selectedServerFromList(
  servers: McpServerSummary[],
  activeServerId: string | null
): McpServerSummary | null {
  return servers.find((server) => server.id === activeServerId) ?? null
}

function serverCategory(server: McpServerSummary): string {
  return server.category ?? '其他'
}

function ResizeSeparator({
  onMouseDown
}: {
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      onMouseDown={onMouseDown}
      sx={{
        width: '1px',
        flexShrink: 0,
        position: 'relative',
        cursor: 'col-resize',
        bgcolor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? 'rgba(241, 246, 246, 0.18)' : 'rgba(15, 42, 48, 0.18)',
        zIndex: 5,
        WebkitAppRegion: 'no-drag',
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: -4,
          right: -4
        }
      }}
    />
  )
}

function DetailPage({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Box
        sx={{
          height: macTitlebarHeight,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          px: 2,
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          WebkitAppRegion: 'drag',
          zIndex: 7
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </Box>
      {children}
    </Box>
  )
}

export function McpSidebar({
  servers,
  activeServerId,
  sidebarWidth = '100%',
  onSelectServer,
  onRefreshServers,
  requestTrustedOverlay,
  cancelTrustedOverlay,
  onPreviewInteractionChange
}: McpSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalogPending, setCatalogPending] = useState(false)
  const catalogDialogs = useMemo(
    () =>
      createTrustedDialogRequestCoordinator({
        request: requestTrustedOverlay
          ? (key, publish, cancel) => {
              try {
                requestTrustedOverlay(key, publish, () => {
                  setCatalogPending(false)
                  cancel()
                })
              } catch (error) {
                setCatalogPending(false)
                throw error
              }
            }
          : undefined,
        cancel: cancelTrustedOverlay
      }),
    [requestTrustedOverlay, cancelTrustedOverlay]
  )
  useEffect(() => () => catalogDialogs.dispose(), [catalogDialogs])
  useEffect(() => {
    if (!catalogOpen && !catalogPending) return undefined
    onPreviewInteractionChange?.(true)
    return () => onPreviewInteractionChange?.(false)
  }, [catalogOpen, catalogPending, onPreviewInteractionChange])
  const openCatalog = (): void => {
    onPreviewInteractionChange?.(true)
    setCatalogPending(true)
    catalogDialogs.request('mcp-sidebar-catalog', () => {
      setCatalogPending(false)
      setCatalogOpen(true)
    })
  }
  const [pendingServerId, setPendingServerId] = useState<string | null>(null)
  const [enabledOverride, setEnabledOverride] = useState<Record<string, boolean>>({})
  const [expandedCategory, setExpandedCategory] = useState<string | null>(() => {
    const activeServer = servers.find((server) => server.id === activeServerId)
    return activeServer ? serverCategory(activeServer) : null
  })
  const normalizedQuery = query.trim().toLowerCase()
  const filteredServers = useMemo(() => {
    if (!normalizedQuery) return servers
    return servers.filter((server) =>
      [
        server.name,
        server.title,
        server.command,
        server.url,
        server.sourcePath,
        ...(server.args ?? []),
        ...(server.envKeys ?? [])
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedQuery))
    )
  }, [normalizedQuery, servers])
  const selectedServer = selectedServerFromList(filteredServers, activeServerId)
  const groups = useMemo(() => {
    const categoryOrder: readonly string[] = [...mcpConnectorCategories, '其他']
    return categoryOrder
      .map((category) => ({
        category,
        entries: filteredServers.filter((server) => serverCategory(server) === category)
      }))
      .filter((group) => group.entries.length > 0)
  }, [filteredServers])

  async function setConnectorEnabled(server: McpServerSummary, enabled: boolean): Promise<void> {
    if (pendingServerId === server.id) return
    setEnabledOverride((current) => ({ ...current, [server.id]: enabled }))
    setPendingServerId(server.id)
    try {
      await window.api.setMcpConnectorEnabled(server.name, enabled, server.sourcePath)
      await onRefreshServers?.()
      setEnabledOverride((current) => {
        const next = { ...current }
        delete next[server.id]
        return next
      })
    } catch {
      setEnabledOverride((current) => {
        const next = { ...current }
        delete next[server.id]
        return next
      })
    } finally {
      setPendingServerId(null)
    }
  }

  const visibleCategory =
    expandedCategory !== '' && groups.some((group) => group.category === expandedCategory)
      ? expandedCategory
      : expandedCategory === '' && !normalizedQuery
        ? null
        : (groups[0]?.category ?? null)

  return (
    <Box
      className="app-sidebar-surface"
      sx={{
        width: sidebarWidth,
        minWidth: 0,
        flexShrink: 0,
        backgroundColor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 2,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ px: 2, pb: 1.5, WebkitAppRegion: 'drag' }}>
        <Stack direction="row" sx={{ mb: 1.5, alignItems: 'center' }}>
          <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 700 }}>
            连接器
          </Typography>
          {onRefreshServers && (
            <DiscoverButton expanded={catalogOpen || catalogPending} onClick={openCatalog} />
          )}
        </Stack>
        <TextField
          size="small"
          fullWidth
          placeholder="搜索连接器"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
          sx={{ WebkitAppRegion: 'no-drag' }}
        />
      </Box>

      <Divider />

      <List
        disablePadding
        sx={{
          overflowY: 'auto',
          flex: 1,
          py: 1,
          backgroundColor: 'transparent !important',
          WebkitAppRegion: 'no-drag'
        }}
      >
        {groups.length === 0 ? (
          <Box sx={{ px: 2, py: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {normalizedQuery ? '没有匹配的已配置连接器' : '尚未配置连接器。点击“发现”浏览目录。'}
            </Typography>
          </Box>
        ) : (
          groups.map((group) => (
            <SidebarAccordionGroup
              key={group.category}
              expanded={visibleCategory === group.category}
              onExpandedChange={(isExpanded) =>
                setExpandedCategory(isExpanded ? group.category : '')
              }
              title={
                <Box component="span" aria-label={`${group.category} · ${group.entries.length}`}>
                  {group.category}
                </Box>
              }
              count={group.entries.length}
            >
              {group.entries.map((server) => {
                const label = server.title ?? server.name
                const active = enabledOverride[server.id] ?? server.enabled !== false
                return (
                  <Box
                    key={server.id}
                    className={selectedServer?.id === server.id ? 'Mui-selected' : undefined}
                    onClick={() => {
                      setExpandedCategory(group.category)
                      onSelectServer(server)
                    }}
                    sx={{
                      ...plainSidebarRowSx,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.25,
                      cursor: 'pointer'
                    }}
                  >
                    <ConnectorIcon connectorId={server.connectorId ?? server.packageId} size={34} />
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}
                    >
                      {label}
                    </Typography>
                    <McpEnableSwitch
                      checked={active}
                      disabled={pendingServerId === server.id}
                      label={active ? `关闭 ${label}` : `启用 ${label}`}
                      onChange={(enabled) => {
                        void setConnectorEnabled(server, enabled)
                      }}
                    />
                  </Box>
                )
              })}
            </SidebarAccordionGroup>
          ))
        )}
      </List>
      {onRefreshServers && (
        <McpConnectorCatalogDialog
          open={catalogOpen}
          servers={servers}
          onClose={() => {
            catalogDialogs.cancel('mcp-sidebar-catalog')
            setCatalogPending(false)
            setCatalogOpen(false)
          }}
          onRefresh={onRefreshServers}
        />
      )}
    </Box>
  )
}

export { McpDetail }

export default function McpView({
  servers,
  activeServerId,
  sidebarWidth,
  onSelectServer,
  onStartSidebarResize
}: McpViewProps): React.JSX.Element {
  const selectedServer = selectedServerFromList(servers, activeServerId)

  return (
    <>
      <McpSidebar
        servers={servers}
        activeServerId={activeServerId}
        sidebarWidth={sidebarWidth}
        onSelectServer={(server) => onSelectServer(server.id)}
      />
      <ResizeSeparator onMouseDown={onStartSidebarResize} />
      <DetailPage title={selectedServer?.name ?? 'MCP'}>
        <McpDetail selectedServer={selectedServer} />
      </DetailPage>
    </>
  )
}
