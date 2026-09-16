import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Box,
  Chip,
  Divider,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { PhiIcons } from '../../icons'
import type { McpServerSummary } from '../../types'

const McpIcon = PhiIcons.entity.mcp
const SearchIcon = PhiIcons.action.search
const TerminalIcon = PhiIcons.tool.command

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
}

export type McpDetailProps = {
  selectedServer: McpServerSummary | null
}

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44
const contentTopGap = 8
const plainSidebarRowSx = {
  alignItems: 'flex-start',
  py: 1.25,
  backgroundColor: 'transparent !important',
  '&:hover': { backgroundColor: 'transparent !important' },
  '&.Mui-selected': {
    backgroundColor: 'transparent !important',
    boxShadow: (theme: Theme) => `inset 3px 0 0 ${theme.palette.primary.main}`
  },
  '&.Mui-selected:hover': { backgroundColor: 'transparent !important' }
} as const

function commandLine(server: McpServerSummary): string {
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
}

function selectedServerFromList(
  servers: McpServerSummary[],
  activeServerId: string | null
): McpServerSummary | null {
  return servers.find((server) => server.id === activeServerId) ?? servers[0] ?? null
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
  onSelectServer
}: McpSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredServers = useMemo(() => {
    if (!normalizedQuery) return servers
    return servers.filter((server) =>
      [
        server.name,
        server.command,
        server.sourcePath,
        ...(server.args ?? []),
        ...(server.envKeys ?? [])
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedQuery))
    )
  }, [normalizedQuery, servers])
  const selectedServer = selectedServerFromList(filteredServers, activeServerId)

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
        <Typography variant="subtitle1" sx={{ display: 'block', mb: 1.5, fontWeight: 700 }}>
          MCP
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="搜索 MCP"
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

      <Box sx={{ px: 2, pb: 1, WebkitAppRegion: 'no-drag' }}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" variant="outlined" label={`${servers.length} 个服务器`} />
          <Chip size="small" color="success" variant="outlined" label="已配置" />
        </Stack>
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
        {filteredServers.map((server) => (
          <ListItemButton
            key={server.id}
            selected={selectedServer?.id === server.id}
            onClick={() => onSelectServer(server)}
            sx={plainSidebarRowSx}
          >
            <Box
              sx={{
                width: 34,
                height: 34,
                mr: 1.25,
                borderRadius: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                flexShrink: 0
              }}
            >
              <McpIcon fontSize="small" />
            </Box>
            <ListItemText
              primary={server.name}
              secondary={server.command || server.sourcePath}
              slotProps={{
                primary: { noWrap: true, sx: { fontSize: '0.9rem', fontWeight: 600 } },
                secondary: {
                  sx: {
                    fontSize: '0.8rem',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }
                }
              }}
            />
          </ListItemButton>
        ))}
      </List>
    </Box>
  )
}

export function McpDetail({ selectedServer }: McpDetailProps): React.JSX.Element {
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {selectedServer ? (
        <Box sx={{ maxWidth: 860, px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
            <Box
              sx={{
                width: 72,
                height: 72,
                borderRadius: 1,
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <McpIcon />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                {selectedServer.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {selectedServer.sourcePath ?? '本地配置'}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                <Chip size="small" color="success" label="已配置" />
                {selectedServer.envKeys?.length ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${selectedServer.envKeys.length} 个环境变量`}
                  />
                ) : null}
              </Stack>
            </Box>
          </Stack>

          <Divider sx={{ my: 4 }} />

          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
            <TerminalIcon fontSize="small" color="action" />
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              命令
            </Typography>
          </Stack>
          <Typography
            component="code"
            sx={{
              display: 'block',
              width: 'fit-content',
              maxWidth: '100%',
              px: 1.25,
              py: 1,
              borderRadius: 1,
              bgcolor: 'action.hover',
              overflowWrap: 'anywhere',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.88rem'
            }}
          >
            {commandLine(selectedServer) || '未配置命令'}
          </Typography>

          {selectedServer.envKeys?.length ? (
            <>
              <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
                环境变量
              </Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                {selectedServer.envKeys.map((key) => (
                  <Chip key={key} size="small" variant="outlined" label={key} />
                ))}
              </Stack>
            </>
          ) : null}
        </Box>
      ) : (
        <Stack spacing={1} sx={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}>
          <McpIcon color="disabled" />
          <Typography color="text.secondary">没有找到 MCP 服务器</Typography>
        </Stack>
      )}
    </Box>
  )
}

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
