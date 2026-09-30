import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Divider,
  InputAdornment,
  List,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import type { SystemStyleObject } from '@mui/system'
import { GoPlus } from 'react-icons/go'
import { PhiIcons } from '../../icons'
import type { McpServerSummary } from '../../types'
import {
  featuredMcpConnectors,
  mcpConnectorCategories,
  type FeaturedMcpConnector
} from '../../../../shared/mcpConnectorCatalog'
import { McpConnectorCatalogDialog } from './components/McpConnectorCatalogDialog'
import { McpEnableSwitch } from './components/McpEnableSwitch'
import { ConnectorIcon } from './components/ConnectorIcon'
import { McpDetailPanel as McpDetail, type McpDetailPanelProps } from './components/McpDetailPanel'

const SearchIcon = PhiIcons.action.search
const ExpandIcon = PhiIcons.action.expand

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

const discoverButtonSx = (theme: Theme): SystemStyleObject<Theme> => {
  const accent = theme.palette.primary.main
  return {
    WebkitAppRegion: 'no-drag',
    position: 'relative',
    overflow: 'hidden',
    flexShrink: 0,
    minWidth: 46,
    width: 46,
    height: 46,
    p: 0,
    borderRadius: '999px',
    border: 0,
    backgroundColor: 'transparent',
    color: accent,
    boxShadow: 'none',
    textTransform: 'none',
    transform: 'none',
    transition: 'none !important',
    '& .discover-plus': {
      position: 'absolute',
      inset: 0,
      display: 'grid',
      placeItems: 'center',
      opacity: 1,
      pointerEvents: 'none'
    },
    '& .discover-plus svg': { fontSize: 26 },
    '& .discover-label': {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 1.5,
      opacity: 0,
      whiteSpace: 'nowrap',
      color: theme.palette.text.primary,
      fontSize: '0.95rem',
      fontWeight: 600,
      pointerEvents: 'none'
    },
    '& .discover-dot': {
      width: 7,
      height: 7,
      borderRadius: '50%',
      backgroundColor: accent
    },
    '&:hover, &[aria-expanded="true"]': {
      width: 128,
      backgroundColor: alpha(accent, theme.palette.mode === 'dark' ? 0.12 : 0.06),
      boxShadow: 'none',
      transform: 'none'
    },
    '&:hover .discover-plus, &[aria-expanded="true"] .discover-plus': {
      opacity: 0
    },
    '&:hover .discover-label, &[aria-expanded="true"] .discover-label': {
      opacity: 1
    },
    '&.Mui-focusVisible': {
      outline: `2px solid ${theme.palette.primary.main}`,
      outlineOffset: 2
    }
  }
}

function selectedServerFromList(
  servers: McpServerSummary[],
  activeServerId: string | null
): McpServerSummary | null {
  return servers.find((server) => server.id === activeServerId) ?? null
}

function featuredConnectorForServer(server: McpServerSummary): FeaturedMcpConnector | undefined {
  return featuredMcpConnectors.find(
    (connector) =>
      connector.url === server.url && (!connector.apiKey || connector.id === server.name)
  )
}

function serverCategory(server: McpServerSummary): string {
  return featuredConnectorForServer(server)?.category ?? '其他'
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
  onRefreshServers
}: McpSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
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
            <Button
              size="small"
              variant="text"
              disableRipple
              aria-label="发现"
              aria-haspopup="dialog"
              aria-expanded={catalogOpen}
              onClick={() => setCatalogOpen(true)}
              sx={discoverButtonSx}
            >
              <Box className="discover-plus" aria-hidden="true">
                <GoPlus />
              </Box>
              <Box className="discover-label" aria-hidden="true">
                <Box className="discover-dot" />
                发现
                <Box className="discover-dot" />
              </Box>
            </Button>
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
            <Accordion
              key={group.category}
              expanded={visibleCategory === group.category}
              onChange={(_event, isExpanded) =>
                setExpandedCategory(isExpanded ? group.category : '')
              }
              disableGutters
              elevation={0}
              sx={{ bgcolor: 'transparent', border: 0, '&::before': { display: 'none' } }}
            >
              <AccordionSummary
                expandIcon={<ExpandIcon fontSize="small" />}
                sx={{ minHeight: 44, px: 2, WebkitAppRegion: 'no-drag' }}
              >
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800 }}>
                  {group.category} · {group.entries.length}
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 0 }}>
                {group.entries.map((server) => {
                  const label = featuredConnectorForServer(server)?.name ?? server.name
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
                      <ConnectorIcon url={server.url} size={34} />
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
              </AccordionDetails>
            </Accordion>
          ))
        )}
      </List>
      {onRefreshServers && (
        <McpConnectorCatalogDialog
          open={catalogOpen}
          servers={servers}
          onClose={() => setCatalogOpen(false)}
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
