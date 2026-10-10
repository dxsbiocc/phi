import { Box, InputAdornment, TextField, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { PhiIcons } from '../icons'

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'

/** One search and content column for the four resource catalog sidebars. */
export function CatalogSidebar({
  title,
  resource,
  width = '100%',
  query,
  onQueryChange,
  searchPlaceholder,
  summary,
  notice,
  action,
  children
}: {
  title: string
  resource: 'skills' | 'connectors' | 'wrappers' | 'plugins'
  width?: number | string
  query: string
  onQueryChange: (query: string) => void
  searchPlaceholder: string
  summary: ReactNode
  notice?: string
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      className="app-sidebar-surface"
      data-phi-catalog-sidebar={resource}
      sx={{
        width,
        minWidth: 0,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF',
        pt: isMac ? '52px' : 2,
        pl: 1,
        pr: 2,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ flexShrink: 0, WebkitAppRegion: 'drag' }}>
        <Box sx={{ height: 36, mb: 1, display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Typography noWrap variant="subtitle1" sx={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
            {title}
          </Typography>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
              WebkitAppRegion: 'no-drag',
              '& .MuiIconButton-root': { width: 32, height: 32 },
              '& .MuiButton-root': {
                width: 32,
                minWidth: 32,
                height: 32,
                '&:hover, &[aria-expanded="true"]': { width: 108 },
                '& .discover-plus svg': { fontSize: 21 },
                '& .discover-label': { gap: 0.75, fontSize: '0.75rem' },
                '& .discover-dot': { width: 4, height: 4 }
              }
            }}
          >
            {action}
          </Box>
        </Box>
        <TextField
          size="small"
          fullWidth
          placeholder={searchPlaceholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          slotProps={{
            htmlInput: { 'aria-label': searchPlaceholder },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <PhiIcons.action.search size={16} />
                </InputAdornment>
              )
            }
          }}
          sx={{
            WebkitAppRegion: 'no-drag',
            '& .MuiInputBase-root': { height: 36, fontSize: '0.8125rem' },
            '& .MuiInputBase-input': { py: 0.75 }
          }}
        />
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          sx={{ display: 'block', mt: 1, height: 20, lineHeight: '20px' }}
        >
          {summary}
        </Typography>
      </Box>
      {notice ? (
        <Typography
          variant="caption"
          color="text.secondary"
          data-phi-catalog-notice={resource}
          sx={{ display: 'block', px: 1, py: 1, flexShrink: 0, lineHeight: 1.5 }}
        >
          {notice}
        </Typography>
      ) : null}
      {children}
    </Box>
  )
}
