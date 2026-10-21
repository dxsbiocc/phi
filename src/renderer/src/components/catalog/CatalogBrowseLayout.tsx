import { useUiLanguage } from '../../lib/i18n'
import { useEffect, useRef } from 'react'
import {
  Box,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../icons'
import { resourceCatalogCopy } from '../../lib/resourceUi'
import { CATALOG_SCROLLBAR_GUTTER } from './catalogPaging'

export interface CatalogBrowseGroup {
  id: string
  label: string
  count: number
}

export function CatalogBrowseLayout({
  title,
  closeLabel,
  groups,
  selectedGroupId,
  onGroupChange,
  query,
  onQueryChange,
  searchLabel,
  hideSearch = false,
  heading,
  filters,
  scrollContent = false,
  onClose,
  busy = false,
  page = 0,
  rowsPerPage = 10,
  actions,
  children,
  footer
}: {
  title: string
  closeLabel: string
  groups: readonly CatalogBrowseGroup[]
  selectedGroupId: string
  onGroupChange: (id: string) => void
  query: string
  onQueryChange: (query: string) => void
  searchLabel: string
  hideSearch?: boolean
  heading?: React.ReactNode
  filters?: React.ReactNode
  scrollContent?: boolean
  onClose: () => void
  busy?: boolean
  page?: number
  rowsPerPage?: number
  actions?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element {
  useUiLanguage()

  const resultsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const results = resultsRef.current
    const scroller =
      results?.querySelector<HTMLElement>('[data-phi-catalog-table-scroll]') ?? results
    if (scroller) scroller.scrollTop = 0
  }, [query, selectedGroupId, page, rowsPerPage])
  const selected = groups.find((group) => group.id === selectedGroupId) ?? groups[0]

  return (
    <Box
      data-phi-catalog-browser={title}
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '216px minmax(0, 1fr)' },
        gridTemplateRows: { xs: 'auto auto minmax(0, 1fr)', md: 'auto minmax(0, 1fr)' },
        height: '100%',
        minHeight: 0
      }}
    >
      <Box
        sx={{
          display: { xs: 'none', md: 'flex' },
          alignItems: 'center',
          px: 2.5,
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: 'background.default'
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
      </Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ gridColumn: { xs: 1, md: 2 }, gridRow: 1, alignItems: 'center', px: 3, py: 2 }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {heading != null && typeof heading !== 'string' ? (
            heading
          ) : (
            <Typography variant="h5" noWrap sx={{ fontWeight: 700 }}>
              {typeof heading === 'string' ? heading : (selected?.label ?? title)}
            </Typography>
          )}
        </Box>
        {actions}
        <IconButton
          aria-label={closeLabel}
          disabled={busy}
          onClick={onClose}
          sx={{ width: 32, height: 32, p: 0, flexShrink: 0, borderRadius: '50%' }}
        >
          <PhiIcons.action.close size={20} />
        </IconButton>
      </Stack>
      <Box
        component="nav"
        aria-label={resourceCatalogCopy.groups(title)}
        sx={{
          gridColumn: 1,
          gridRow: 2,
          minHeight: 0,
          overflow: 'auto',
          px: 1.5,
          pb: 1.5,
          borderRightWidth: { xs: 0, md: 1 },
          borderRightStyle: 'solid',
          borderColor: 'divider',
          bgcolor: 'background.default'
        }}
      >
        <List disablePadding sx={{ display: { xs: 'flex', md: 'block' } }}>
          {groups.map((group) => (
            <ListItemButton
              key={group.id}
              selected={selectedGroupId === group.id}
              aria-pressed={selectedGroupId === group.id}
              onClick={() => onGroupChange(group.id)}
              sx={{ borderRadius: 1.5, mb: { xs: 0, md: 0.5 }, flexShrink: 0, gap: 1 }}
            >
              <Typography
                variant="body2"
                noWrap
                sx={{ flex: 1, fontWeight: 500 }}
                title={group.label}
              >
                {group.label}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
              >
                {group.count}
              </Typography>
            </ListItemButton>
          ))}
        </List>
      </Box>
      <Box
        sx={{
          gridColumn: { xs: 1, md: 2 },
          gridRow: { xs: 3, md: 2 },
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {hideSearch ? null : (
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 3, pb: 2 }}>
            <TextField
              fullWidth
              size="small"
              value={query}
              placeholder={searchLabel}
              onChange={(event) => onQueryChange(event.target.value)}
              slotProps={{
                htmlInput: { 'aria-label': searchLabel },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <PhiIcons.action.search size={16} />
                    </InputAdornment>
                  )
                }
              }}
            />
            {filters}
          </Stack>
        )}
        <Box
          ref={resultsRef}
          sx={{
            flex: 1,
            width: '100%',
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: scrollContent ? 'auto' : 'hidden',
            // Card catalogs scroll this box. The 12px gutter sits inside the 24px padding, so the cards' right edge matches the pager.
            scrollbarGutter: scrollContent ? 'stable' : 'auto',
            pl: 3,
            pr: scrollContent ? CATALOG_SCROLLBAR_GUTTER : 3,
            pb: 2
          }}
        >
          {children}
        </Box>
        {footer ? <Box sx={{ px: 3, py: 1.5 }}>{footer}</Box> : null}
      </Box>
    </Box>
  )
}
