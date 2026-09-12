import { useMemo, useState, type MouseEvent } from 'react'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Alert,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { PhiIcons } from '../../icons'
import type { PluginCatalogItem } from '../../types'

const DownloadIcon = PhiIcons.action.download
const ExtensionIcon = PhiIcons.entity.plugin
const OpenInNewIcon = PhiIcons.action.openExternal
const SearchIcon = PhiIcons.action.search
const RefreshIcon = PhiIcons.action.refresh

type PluginViewProps = {
  plugins: PluginCatalogItem[]
  isLoading: boolean
  activePluginId: string | null
  busySource: string | null
  operationError: string | null
  sidebarWidth: number
  onSelectPlugin: (id: string) => void
  onInstall: (source: string) => void
  onRemove: (source: string) => void
  onRefresh: () => void
  onStartSidebarResize: (event: MouseEvent<HTMLDivElement>) => void
}

const kindLabels: Record<PluginCatalogItem['kind'], string> = {
  extension: 'Extension',
  skill: 'Skill',
  prompt: 'Prompt',
  theme: 'Theme',
  package: 'Package'
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

function pluginTitle(plugin: PluginCatalogItem): string {
  return plugin.name.length > 48 ? `${plugin.name.slice(0, 48)}...` : plugin.name
}

export default function PluginView({
  plugins,
  isLoading,
  activePluginId,
  busySource,
  operationError,
  sidebarWidth,
  onSelectPlugin,
  onInstall,
  onRemove,
  onRefresh,
  onStartSidebarResize
}: PluginViewProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pendingAction, setPendingAction] = useState<{
    type: 'install' | 'remove'
    plugin: PluginCatalogItem
  } | null>(null)
  const normalizedQuery = query.trim().toLowerCase()

  const filteredPlugins = useMemo(() => {
    if (!normalizedQuery) return plugins
    return plugins.filter((plugin) =>
      [plugin.name, plugin.description, plugin.author, plugin.kind]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedQuery))
    )
  }, [normalizedQuery, plugins])

  const selectedPlugin =
    filteredPlugins.find((plugin) => plugin.id === activePluginId) ?? filteredPlugins[0] ?? null
  const installedCount = plugins.filter((plugin) => plugin.installed).length
  const pendingActionTitle = pendingAction?.type === 'install' ? '安装插件' : '卸载插件'

  const confirmPendingAction = (): void => {
    if (!pendingAction) return
    if (pendingAction.type === 'install') {
      onInstall(pendingAction.plugin.source)
    } else {
      onRemove(pendingAction.plugin.source)
    }
    setPendingAction(null)
  }

  return (
    <>
      <Box
        className="app-sidebar-surface"
        sx={{
          width: sidebarWidth,
          flexShrink: 0,
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 2,
          WebkitAppRegion: 'no-drag'
        }}
      >
        <Box sx={{ px: 2, pb: 1.5, WebkitAppRegion: 'drag' }}>
          <Stack
            direction="row"
            sx={{ mb: 1.5, alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.5 }}>
              插件
            </Typography>
            <Tooltip title="刷新">
              <span>
                <IconButton
                  aria-label="刷新"
                  size="small"
                  onClick={onRefresh}
                  disabled={isLoading}
                  sx={{ WebkitAppRegion: 'no-drag' }}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
          <TextField
            size="small"
            fullWidth
            placeholder="在 pi.dev/packages 中搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            slotProps={{
              htmlInput: {
                'data-phi-focus': 'view-search'
              },
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
            <Chip size="small" variant="outlined" label={`${plugins.length} 个插件`} />
            <Chip
              size="small"
              color="success"
              variant="outlined"
              label={`${installedCount} 已安装`}
            />
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
          {isLoading && plugins.length === 0 ? (
            <Stack spacing={1.5} sx={{ py: 4, alignItems: 'center' }}>
              <CircularProgress size={22} />
              <Typography variant="body2" color="text.secondary">
                正在读取插件源
              </Typography>
            </Stack>
          ) : (
            filteredPlugins.map((plugin) => (
              <ListItemButton
                key={plugin.id}
                selected={selectedPlugin?.id === plugin.id}
                onClick={() => onSelectPlugin(plugin.id)}
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
                    bgcolor: plugin.installed ? 'success.main' : 'background.paper',
                    border: plugin.installed ? 0 : 1,
                    borderColor: 'divider',
                    color: plugin.installed ? 'success.contrastText' : 'text.secondary',
                    flexShrink: 0
                  }}
                >
                  <ExtensionIcon fontSize="small" />
                </Box>
                <ListItemText
                  primary={pluginTitle(plugin)}
                  secondary={plugin.description || plugin.source}
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
            ))
          )}
        </List>
      </Box>

      <Box
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        onMouseDown={onStartSidebarResize}
        sx={{
          width: '1px',
          flexShrink: 0,
          position: 'relative',
          cursor: 'col-resize',
          bgcolor: (muiTheme) =>
            muiTheme.palette.mode === 'dark'
              ? 'rgba(241, 246, 246, 0.18)'
              : 'rgba(15, 42, 48, 0.18)',
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
            {selectedPlugin?.name ?? '插件'}
          </Typography>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {selectedPlugin ? (
            <Box sx={{ maxWidth: 860, px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
              <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
                <Box
                  sx={{
                    width: 72,
                    height: 72,
                    borderRadius: 1,
                    bgcolor: selectedPlugin.installed ? 'success.main' : 'primary.main',
                    color: '#FFFFFF',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0
                  }}
                >
                  <ExtensionIcon />
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                    {selectedPlugin.name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    {selectedPlugin.author ? `${selectedPlugin.author} · ` : ''}
                    {kindLabels[selectedPlugin.kind]}
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                    {selectedPlugin.installed ? (
                      <Chip size="small" color="success" label="已安装" />
                    ) : (
                      <Chip size="small" label="未安装" />
                    )}
                    {selectedPlugin.downloads ? (
                      <Chip size="small" variant="outlined" label={selectedPlugin.downloads} />
                    ) : null}
                    {selectedPlugin.updated ? (
                      <Chip size="small" variant="outlined" label={selectedPlugin.updated} />
                    ) : null}
                  </Stack>
                </Box>
              </Stack>

              <Stack direction="row" spacing={1.25} sx={{ mt: 3, flexWrap: 'wrap', rowGap: 1 }}>
                {selectedPlugin.installed ? (
                  <Button
                    variant="outlined"
                    color="error"
                    disabled={busySource === selectedPlugin.source}
                    onClick={() => setPendingAction({ type: 'remove', plugin: selectedPlugin })}
                  >
                    卸载
                  </Button>
                ) : (
                  <Button
                    variant="contained"
                    startIcon={<DownloadIcon />}
                    disabled={busySource === selectedPlugin.source}
                    onClick={() => setPendingAction({ type: 'install', plugin: selectedPlugin })}
                  >
                    安装
                  </Button>
                )}
                <Button
                  component="a"
                  href={selectedPlugin.homepageUrl}
                  target="_blank"
                  rel="noreferrer"
                  variant="outlined"
                  endIcon={<OpenInNewIcon />}
                >
                  pi.dev
                </Button>
                <Button
                  component="a"
                  href={selectedPlugin.npmUrl}
                  target="_blank"
                  rel="noreferrer"
                  variant="outlined"
                  endIcon={<OpenInNewIcon />}
                >
                  npm
                </Button>
              </Stack>

              {busySource === selectedPlugin.source ? (
                <Stack direction="row" spacing={1.5} sx={{ mt: 3, alignItems: 'center' }}>
                  <CircularProgress size={18} />
                  <Typography variant="body2" color="text.secondary">
                    正在同步插件
                  </Typography>
                </Stack>
              ) : null}

              {operationError ? (
                <Alert severity="error" sx={{ mt: 3 }}>
                  {operationError}
                </Alert>
              ) : null}

              <Divider sx={{ my: 4 }} />

              <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
                说明
              </Typography>
              <Typography variant="body1" sx={{ maxWidth: 720 }}>
                {selectedPlugin.description || '此插件来自 Pi 插件目录。'}
              </Typography>

              <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
                安装源
              </Typography>
              <Tooltip title="Pi SDK 会使用这个源安装插件">
                <Box
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
                  pi install {selectedPlugin.source}
                </Box>
              </Tooltip>

              {selectedPlugin.installedPath ? (
                <>
                  <Typography variant="h6" sx={{ fontWeight: 700, mt: 4, mb: 1 }}>
                    本地路径
                  </Typography>
                  <Typography
                    component="code"
                    sx={{
                      display: 'block',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.84rem',
                      color: 'text.secondary',
                      overflowWrap: 'anywhere'
                    }}
                  >
                    {selectedPlugin.installedPath}
                  </Typography>
                </>
              ) : null}
            </Box>
          ) : (
            <Stack
              spacing={1}
              sx={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}
            >
              <ExtensionIcon color="disabled" />
              <Typography color="text.secondary">没有找到插件</Typography>
            </Stack>
          )}
        </Box>
      </Box>

      <Dialog open={pendingAction !== null} onClose={() => setPendingAction(null)}>
        <DialogTitle>{pendingActionTitle}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {pendingAction?.type === 'install'
              ? '确认通过 Pi runtime 安装这个插件源。'
              : '确认从 Pi runtime 移除这个插件源。'}
          </Typography>
          <Box
            component="code"
            sx={{
              display: 'block',
              maxWidth: 520,
              px: 1.25,
              py: 1,
              borderRadius: 1,
              bgcolor: 'action.hover',
              overflowWrap: 'anywhere',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.88rem'
            }}
          >
            {pendingAction?.plugin.source}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingAction(null)}>取消</Button>
          <Button
            variant="contained"
            color={pendingAction?.type === 'remove' ? 'error' : 'primary'}
            onClick={confirmPendingAction}
          >
            确认
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
