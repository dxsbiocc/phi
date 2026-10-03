import { Box, Button } from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import type { SystemStyleObject } from '@mui/system'
import { GoPlus } from 'react-icons/go'

/** The sidebar's "add from catalog" action: a plus that widens into “发现” on hover or while open. */
export function DiscoverButton({
  expanded,
  onClick,
  label = '发现'
}: {
  expanded: boolean
  onClick: () => void
  label?: string
}): React.JSX.Element {
  return (
    <Button
      size="small"
      variant="text"
      disableRipple
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onClick}
      sx={discoverButtonSx}
    >
      <Box className="discover-plus" aria-hidden="true">
        <GoPlus />
      </Box>
      <Box className="discover-label" aria-hidden="true">
        <Box className="discover-dot" />
        {label}
        <Box className="discover-dot" />
      </Box>
    </Button>
  )
}

const discoverButtonSx = (theme: Theme): SystemStyleObject<Theme> => {
  const accent = theme.palette.primary.main
  return {
    WebkitAppRegion: 'no-drag',
    position: 'relative',
    overflow: 'hidden',
    flexShrink: 0,
    minWidth: 46,
    width: 46,
    height: 46,
    p: 0,
    borderRadius: '999px',
    border: 0,
    backgroundColor: 'transparent',
    color: accent,
    boxShadow: 'none',
    textTransform: 'none',
    transform: 'none',
    transition: 'none !important',
    '& .discover-plus': {
      position: 'absolute',
      inset: 0,
      display: 'grid',
      placeItems: 'center',
      opacity: 1,
      pointerEvents: 'none'
    },
    '& .discover-plus svg': { fontSize: 26 },
    '& .discover-label': {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 1.5,
      opacity: 0,
      whiteSpace: 'nowrap',
      color: theme.palette.text.primary,
      fontSize: '0.95rem',
      fontWeight: 600,
      pointerEvents: 'none'
    },
    '& .discover-dot': {
      width: 7,
      height: 7,
      borderRadius: '50%',
      backgroundColor: accent
    },
    '&:hover, &[aria-expanded="true"]': {
      width: 128,
      backgroundColor: alpha(accent, theme.palette.mode === 'dark' ? 0.12 : 0.06),
      boxShadow: 'none',
      transform: 'none'
    },
    '&:hover .discover-plus, &[aria-expanded="true"] .discover-plus': {
      opacity: 0
    },
    '&:hover .discover-label, &[aria-expanded="true"] .discover-label': {
      opacity: 1
    },
    '&.Mui-focusVisible': {
      outline: `2px solid ${theme.palette.primary.main}`,
      outlineOffset: 2
    }
  }
}
