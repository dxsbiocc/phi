import { useMemo, useState } from 'react'
import { Box, CircularProgress, IconButton, List, Stack, Typography } from '@mui/material'

import { SidebarAccordionGroup } from '../../../components/SidebarAccordionGroup'
import { CatalogSidebar } from '../../../components/CatalogSidebar'
import { CatalogResourceRow } from '../../../components/CatalogResourceRow'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { PhiIcons } from '../../../icons'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import {
  filterPhiPlugins,
  groupPhiPlugins,
  visiblePhiPluginCategory
} from '../lib/phiPluginSidebar'
import { phiPluginSourceCategoryLabels, type PhiPluginSourceCategory } from '../lib/phiPlugins'
import { DiscoverButton } from '../../../components/DiscoverButton'

export type PhiPluginSidebarProps = {
  plugins: readonly PhiPluginDisplayItem[]
  loading: boolean
  activePluginId: string | null
  onSelectPlugin: (plugin: PhiPluginDisplayItem) => void
  onSetEnabled?: (plugin: PhiPluginDisplayItem, enabled: boolean) => void | Promise<void | boolean>
  busyPluginId?: string | null
  onOpenCatalog: () => void
  catalogOpen?: boolean
}

export function PhiPluginSidebar({
  plugins,
  loading,
  activePluginId,
  onSelectPlugin,
  onSetEnabled,
  busyPluginId,
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
    <CatalogSidebar
      title="插件"
      resource="plugins"
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="搜索插件"
      summary={`${plugins.length} 个已安装`}
      action={<DiscoverButton expanded={catalogOpen} onClick={onOpenCatalog} />}
    >
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
                <CatalogResourceRow
                  key={plugin.id}
                  id={plugin.id}
                  resource="plugins"
                  label={plugin.title}
                  enabled={plugin.enabled}
                  selected={plugin.id === activePluginId}
                  busy={busyPluginId === plugin.id}
                  onSelect={() => {
                    setManualExpandedCategory(group.category)
                    onSelectPlugin(plugin)
                  }}
                  onEnabledChange={
                    onSetEnabled ? (checked) => onSetEnabled(plugin, checked) : undefined
                  }
                  icon={
                    <Box
                      sx={{
                        width: 32,
                        height: 32,
                        flexShrink: 0,
                        borderRadius: 1.25,
                        display: 'grid',
                        placeItems: 'center',
                        color: plugin.enabled ? 'primary.main' : 'text.disabled',
                        bgcolor: 'action.hover'
                      }}
                    >
                      <ResourceIcon icon={plugin.icon} kind="plugin" size={32} fallbackSize={20} />
                    </Box>
                  }
                >
                  <Typography
                    noWrap
                    title={plugin.title}
                    sx={{ fontSize: '0.875rem', fontWeight: 600, lineHeight: 1.25 }}
                  >
                    {plugin.title}
                  </Typography>
                  <Typography
                    noWrap
                    title={`${plugin.id} · v${plugin.version}`}
                    variant="caption"
                    color="text.secondary"
                    sx={{
                      display: 'block',
                      mt: 0.25,
                      fontSize: '0.75rem',
                      lineHeight: 1.25,
                      fontFamily: 'var(--font-mono)'
                    }}
                  >
                    {plugin.id} · v{plugin.version}
                  </Typography>
                </CatalogResourceRow>
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
    </CatalogSidebar>
  )
}
