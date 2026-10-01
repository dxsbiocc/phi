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
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { PhiIcons } from '../../../icons'
import type { PluginCatalogItem } from '../../../types'

const ExtensionIcon = PhiIcons.entity.plugin
const SearchIcon = PhiIcons.action.search
const RefreshIcon = PhiIcons.action.refresh

export type DeveloperExtensionsSidebarProps = {
  extensions: PluginCatalogItem[]
  isLoading: boolean
  activeExtensionId: string | null
  onSelectExtension: (extension: PluginCatalogItem) => void
  onRefresh: () => void
}

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

function extensionTitle(extension: PluginCatalogItem): string {
  return extension.name.length > 48 ? `${extension.name.slice(0, 48)}...` : extension.name
}

function selectedExtensionFromList(
  extensions: PluginCatalogItem[],
  activeExtensionId: string | null
): PluginCatalogItem | null {
  return extensions.find((extension) => extension.id === activeExtensionId) ?? null
}

export function DeveloperExtensionsSidebar({
  extensions,
  isLoading,
  activeExtensionId,
  onSelectExtension,
  onRefresh
}: DeveloperExtensionsSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredExtensions = useMemo(() => {
    if (!normalizedQuery) return extensions
    return extensions.filter((extension) =>
      [extension.name, extension.description, extension.author, extension.kind]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedQuery))
    )
  }, [extensions, normalizedQuery])
  const selectedExtension = selectedExtensionFromList(filteredExtensions, activeExtensionId)
  const installedCount = extensions.filter((extension) => extension.installed).length

  return (
    <Box
      sx={{
        width: 300,
        minWidth: 240,
        flexShrink: 0,
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      <Box sx={{ px: 2, pt: 2, pb: 1.5 }}>
        <Stack
          direction="row"
          sx={{ mb: 1.5, alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.5 }}>
            开发者扩展
          </Typography>
          <Tooltip title="刷新">
            <span>
              <IconButton
                aria-label="刷新开发者扩展"
                size="small"
                onClick={onRefresh}
                disabled={isLoading}
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
              'data-phi-focus': 'developer-extension-search'
            },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
        />
      </Box>

      <Box sx={{ px: 2, pb: 1 }}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" variant="outlined" label={`${extensions.length} 个开发者扩展`} />
          <Chip
            size="small"
            color="success"
            variant="outlined"
            label={`${installedCount} 已安装`}
          />
        </Stack>
      </Box>

      <Divider />

      <List disablePadding sx={{ overflowY: 'auto', flex: 1, py: 1 }}>
        {isLoading && extensions.length === 0 ? (
          <Stack spacing={1.5} sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress size={22} />
            <Typography variant="body2" color="text.secondary">
              正在读取开发者扩展目录
            </Typography>
          </Stack>
        ) : (
          filteredExtensions.map((extension) => (
            <ListItemButton
              key={extension.id}
              selected={selectedExtension?.id === extension.id}
              onClick={() => onSelectExtension(extension)}
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
                  bgcolor: extension.installed ? 'success.main' : 'background.paper',
                  border: extension.installed ? 0 : 1,
                  borderColor: 'divider',
                  color: extension.installed ? 'success.contrastText' : 'text.secondary',
                  flexShrink: 0
                }}
              >
                <ExtensionIcon fontSize="small" />
              </Box>
              <ListItemText
                primary={extensionTitle(extension)}
                secondary={extension.description || extension.source}
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
  )
}
