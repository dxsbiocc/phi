import { Box, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons, directoryIconForPath, fileIconForPath } from '../../../icons'
import type { FileTreeEntry } from '../../../types'

const CollapseIcon = PhiIcons.action.expand
const ExpandIcon = PhiIcons.action.back

export function FileTreeRow({
  entry,
  depth,
  isExpanded,
  isActive,
  onClick
}: {
  entry: FileTreeEntry
  depth: number
  isExpanded: boolean
  isActive: boolean
  onClick: () => void
}): React.JSX.Element {
  const isDirectory = entry.kind === 'directory'
  const entryIcon = isDirectory
    ? directoryIconForPath(entry.path, isExpanded)
    : fileIconForPath(entry.path)
  const EntryIcon = entryIcon.Icon
  const ChevronIcon = isExpanded ? CollapseIcon : ExpandIcon

  return (
    <Box
      component="button"
      type="button"
      data-phi-file-kind={entryIcon.kind}
      title={entry.displayPath}
      onClick={onClick}
      sx={{
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        minHeight: 32,
        px: 1,
        py: 0.45,
        pl: 1 + depth * 1.75,
        border: 0,
        borderRadius: 1,
        bgcolor: (theme) => (isActive ? alpha(theme.palette.primary.main, 0.1) : 'transparent'),
        color: isActive ? 'primary.main' : 'text.primary',
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        '&:hover': {
          bgcolor: (theme) =>
            isActive
              ? alpha(theme.palette.primary.main, 0.13)
              : alpha(theme.palette.text.primary, 0.055)
        },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: -2
        }
      }}
    >
      {isDirectory ? (
        <ChevronIcon fontSize="small" sx={{ color: 'text.secondary' }} />
      ) : (
        <Box sx={{ width: '1.25rem', flexShrink: 0 }} />
      )}
      <EntryIcon fontSize="small" sx={{ color: entryIcon.color, opacity: isDirectory ? 0.9 : 1 }} />
      <Typography
        variant="body2"
        sx={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: entry.name.startsWith('.') ? 'var(--font-mono)' : undefined
        }}
      >
        {entry.name}
      </Typography>
    </Box>
  )
}
