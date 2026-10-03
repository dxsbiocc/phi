import { useMemo, useState } from 'react'
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'

import { SidebarAccordionGroup } from '../../../components/SidebarAccordionGroup'
import { PhiIcons } from '../../../icons'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import {
  filterPhiPlugins,
  groupPhiPlugins,
  visiblePhiPluginCategory
} from '../lib/phiPluginSidebar'
import { phiPluginSourceCategoryLabels, type PhiPluginSourceCategory } from '../lib/phiPlugins'
import { DiscoverButton } from '../../../components/DiscoverButton'

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const MAC_TITLEBAR_HEIGHT = 44
const CONTENT_TOP_GAP = 8

const rowSx = {
  mx: 1,
  my: 0.25,
  px: 1.5,
  py: 1,
  gap: 1.25,
  borderRadius: 1.5,
  backgroundColor: 'transparent !important',
  '&:hover': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.12 : 0.06)} !important`
  },
  '&.Mui-selected': {
    backgroundColor: (theme: Theme) =>
      `${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)} !important`
  }
} as const

export type PhiPluginSidebarProps = {
  plugins: readonly PhiPluginDisplayItem[]
  loading: boolean
  activePluginId: string | null
  onSelectPlugin: (plugin: PhiPluginDisplayItem) => void
  onOpenCatalog: () => void
  catalogOpen?: boolean
}

export function PhiPluginSidebar({
  plugins,
  loading,
  activePluginId,
  onSelectPlugin,
  onOpenCatalog,
  catalogOpen = false
}: PhiPluginSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredPlugins = useMemo(() => filterPhiPlugins(plugins, query), [plugins, query])
  const groups = useMemo(() => groupPhiPlugins(filteredPlugins), [filteredPlugins])
  const activeCategory =
    plugins.find((plugin) => plugin.id === activePluginId)?.distribution ?? null
  const [manualExpandedCategory, setManualExpandedCategory] = useState<
    PhiPluginSourceCategory | null | undefined
  >(undefined)
  const [trackedActiveCategory, setTrackedActiveCategory] = useState(activeCategory)
  if (activeCategory !== trackedActiveCategory) {
    setTrackedActiveCategory(activeCategory)
    if (activeCategory) setManualExpandedCategory(activeCategory)
  }
  const expandedCategory =
    manualExpandedCategory !== undefined
      ? manualExpandedCategory
      : (activeCategory ?? groups[0]?.category ?? null)
  const visibleCategory = visiblePhiPluginCategory(groups, expandedCategory, query)

  return (
    <Box
      className="app-sidebar-surface"
      data-phi-plugin-sidebar="true"
      sx={{
        width: '100%',
        minWidth: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF',
        pt: isMac ? `${MAC_TITLEBAR_HEIGHT + CONTENT_TOP_GAP}px` : 2,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ px: 2, pb: 1.5, WebkitAppRegion: 'drag' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5 }}>
          <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 700 }}>
            插件
          </Typography>
          <DiscoverButton expanded={catalogOpen} onClick={onOpenCatalog} />
        </Stack>
        <TextField
          size="small"
          fullWidth
          placeholder="搜索插件"
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
          sx={{ WebkitAppRegion: 'no-drag' }}
        />
      </Box>

      <Box sx={{ px: 2, pb: 1 }}>
        <Chip size="small" variant="outlined" label={`${plugins.length} 个已安装`} />
      </Box>
      <Divider />

      <List disablePadding sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 1 }}>
        {loading && plugins.length === 0 ? (
          <Stack spacing={1.25} sx={{ alignItems: 'center', py: 5 }}>
            <CircularProgress size={22} />
            <Typography variant="body2" color="text.secondary">
              正在读取插件
            </Typography>
          </Stack>
        ) : groups.length > 0 ? (
          groups.map((group) => (
            <SidebarAccordionGroup
              key={group.category}
              expanded={visibleCategory === group.category}
              onExpandedChange={(expanded) =>
                setManualExpandedCategory(expanded ? group.category : null)
              }
              title={phiPluginSourceCategoryLabels[group.category]}
              count={group.plugins.length}
            >
              {group.plugins.map((plugin) => (
                <ListItemButton
                  key={plugin.id}
                  selected={plugin.id === activePluginId}
                  onClick={() => {
                    setManualExpandedCategory(group.category)
                    onSelectPlugin(plugin)
                  }}
                  sx={rowSx}
                >
                  <Box
                    sx={{
                      width: 36,
                      height: 36,
                      flexShrink: 0,
                      borderRadius: 1.25,
                      display: 'grid',
                      placeItems: 'center',
                      color: plugin.enabled ? 'primary.main' : 'text.disabled',
                      bgcolor: 'action.hover'
                    }}
                  >
                    <PhiIcons.entity.plugin size={21} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography noWrap sx={{ fontSize: '0.9rem', fontWeight: 700 }}>
                      {plugin.title}
                    </Typography>
                    <Typography
                      noWrap
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', fontFamily: 'var(--font-mono)' }}
                    >
                      {plugin.id} · v{plugin.version}
                    </Typography>
                  </Box>
                  <Tooltip title={plugin.enabled ? '已启用' : '已停用'}>
                    <Box
                      component="span"
                      aria-label={plugin.enabled ? '已启用' : '已停用'}
                      sx={{
                        width: 8,
                        height: 8,
                        flexShrink: 0,
                        borderRadius: '50%',
                        bgcolor: plugin.enabled ? 'success.main' : 'text.disabled'
                      }}
                    />
                  </Tooltip>
                </ListItemButton>
              ))}
            </SidebarAccordionGroup>
          ))
        ) : (
          <Stack spacing={1.25} sx={{ alignItems: 'center', textAlign: 'center', px: 2, py: 5 }}>
            <PhiIcons.entity.plugin color="disabled" />
            <Typography variant="body2" color="text.secondary">
              {normalizedQuery ? '没有匹配的插件' : '尚未安装插件'}
            </Typography>
            {!normalizedQuery ? (
              <IconButton aria-label="添加插件" color="primary" onClick={onOpenCatalog}>
                <PhiIcons.action.add size={20} />
              </IconButton>
            ) : null}
          </Stack>
        )}
      </List>
    </Box>
  )
}
