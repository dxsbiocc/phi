import { useMemo } from 'react'
import {
  Box,
  CircularProgress,
  InputAdornment,
  List,
  ListItemButton,
  TextField,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import type { OfficialWrapperToolChoice } from '../lib/officialWrapperCatalog'
import {
  filterOfficialWrapperTools,
  officialWrapperToolShortName
} from '../lib/officialWrapperCatalog'
import { wrapperCopy } from '../lib/wrapperCopy'

export function OfficialWrapperToolList({
  suite,
  choices,
  selectedId,
  query,
  loading,
  onQueryChange,
  onSelect
}: {
  suite: string
  choices: readonly OfficialWrapperToolChoice[]
  selectedId?: string
  query: string
  loading: boolean
  onQueryChange: (value: string) => void
  onSelect: (id: string) => void
}): React.JSX.Element {
  useUiLanguage()
  const tools = useMemo(() => choices.map(({ tool }) => tool), [choices])
  const filtered = useMemo(() => filterOfficialWrapperTools(tools, query), [tools, query])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <TextField
        fullWidth
        size="small"
        value={query}
        placeholder={wrapperCopy.searchTools}
        onChange={(event) => onQueryChange(event.target.value)}
        slotProps={{
          htmlInput: { 'aria-label': wrapperCopy.searchTools },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <PhiIcons.action.search size={16} />
              </InputAdornment>
            )
          }
        }}
        sx={{ mb: 1.5, flexShrink: 0 }}
      />
      {loading ? (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 4 }}>
          <CircularProgress size={22} />
        </Box>
      ) : filtered.length === 0 ? (
        <Typography color="text.secondary" variant="body2" sx={{ py: 2 }}>
          {wrapperCopy.noSuiteTools}
        </Typography>
      ) : (
        <List
          dense
          disablePadding
          aria-label={wrapperCopy.wrapperToolList}
          data-phi-wrapper-tool-list="true"
          sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
        >
          {filtered.map((tool) => {
            const selected = tool.id === selectedId
            const label = officialWrapperToolShortName(suite, tool.name)
            return (
              <ListItemButton
                key={tool.id}
                selected={selected}
                aria-pressed={selected}
                data-phi-wrapper-catalog-tool={tool.id}
                onClick={() => onSelect(tool.id)}
                sx={{
                  minHeight: 34,
                  mb: 0.25,
                  color: selected ? 'primary.main' : 'text.secondary',
                  '&.Mui-selected': {
                    bgcolor: (theme) =>
                      alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.22 : 0.1)
                  }
                }}
              >
                <Typography
                  variant="body2"
                  noWrap
                  title={tool.name}
                  sx={{ fontWeight: selected ? 600 : 400 }}
                >
                  {label}
                </Typography>
              </ListItemButton>
            )
          })}
        </List>
      )}
    </Box>
  )
}
