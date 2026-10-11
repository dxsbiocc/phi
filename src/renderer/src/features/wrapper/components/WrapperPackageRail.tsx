import { useMemo, useState } from 'react'
import { Box, InputAdornment, List, ListItemButton, TextField, Typography } from '@mui/material'

import type { WrapperCompositionManifest } from '../../../../../shared/wrapperCompositionManifestTypes'
import { PhiIcons } from '../../../icons'
import { wrapperToolLabel } from '../lib/wrapperFamily'
import { filterWrapperMembers } from '../lib/wrapperPackageDetail'

/** The tools of the open wrapper's package; choosing one opens that tool's page. */
export function WrapperPackageRail<T extends WrapperCompositionManifest>({
  familyName,
  members,
  selectedId,
  onSelect,
  showHeading = true
}: {
  familyName: string
  members: readonly T[]
  selectedId: string | null
  onSelect: (entry: T) => void
  /** Hide the family title where the surrounding page already shows it. */
  showHeading?: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const visible = useMemo(() => filterWrapperMembers(members, query), [members, query])
  return (
    <Box
      component="nav"
      aria-label={`${familyName} 包内工具`}
      data-phi-wrapper-package-rail={familyName}
      sx={{
        width: 240,
        flexShrink: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'background.default'
      }}
    >
      {showHeading ? (
        <Box sx={{ px: 2, pt: 2, pb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
            {familyName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {members.length} 个工具
          </Typography>
        </Box>
      ) : (
        <Box sx={{ pt: 1 }} />
      )}
      {members.length > 6 ? (
        <Box sx={{ px: 1.5, pb: 1 }}>
          <TextField
            fullWidth
            size="small"
            value={query}
            placeholder="搜索工具"
            onChange={(event) => setQuery(event.target.value)}
            slotProps={{
              htmlInput: { 'aria-label': '搜索包内工具' },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <PhiIcons.action.search size={16} />
                  </InputAdornment>
                )
              }
            }}
          />
        </Box>
      ) : null}
      <List disablePadding sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1.5, pb: 1.5 }}>
        {visible.map((entry) => (
          <ListItemButton
            key={entry.id}
            selected={entry.id === selectedId}
            aria-pressed={entry.id === selectedId}
            data-phi-wrapper-member={entry.id}
            onClick={() => onSelect(entry)}
            sx={{ borderRadius: 1.5, mb: 0.5 }}
          >
            <Typography
              variant="body2"
              noWrap
              title={entry.name}
              sx={{ flex: 1, fontFamily: 'var(--font-mono)' }}
            >
              {wrapperToolLabel(familyName, entry.id)}
            </Typography>
          </ListItemButton>
        ))}
        {visible.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
            没有匹配的工具
          </Typography>
        ) : null}
      </List>
    </Box>
  )
}
