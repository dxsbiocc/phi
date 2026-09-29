import type { SxProps, Theme } from '@mui/material'

export const COMPACT_COMPOSER_CONTROL_SIZE = 32
export const REGULAR_COMPOSER_ACTION_SIZE = 40
export const COMPOSER_ICON_SIZE = 18

export function composerSurfaceSx({
  compact,
  dragActive
}: {
  compact: boolean
  dragActive: boolean
}): SxProps<Theme> {
  return {
    borderRadius: 2,
    px: compact ? 1.25 : 2,
    pt: 1.5,
    pb: 1,
    cursor: 'text',
    borderColor: (theme) =>
      dragActive
        ? theme.palette.primary.main
        : theme.palette.mode === 'dark'
          ? 'rgba(241, 246, 246, 0.18)'
          : 'rgba(15, 42, 48, 0.14)',
    bgcolor: (theme) =>
      dragActive
        ? theme.palette.mode === 'dark'
          ? 'rgba(50, 177, 194, 0.08)'
          : 'rgba(26, 153, 173, 0.06)'
        : 'background.paper',
    boxShadow: (theme) =>
      dragActive
        ? `0 0 0 3px ${theme.palette.mode === 'dark' ? 'rgba(50, 177, 194, 0.12)' : 'rgba(26, 153, 173, 0.12)'}`
        : 'none',
    transition: 'border-color 200ms, background-color 200ms, box-shadow 200ms',
    '&:focus-within': { borderColor: 'primary.main' },
    '& .MuiButton-root:hover, & .MuiIconButton-root:hover': { transform: 'none' }
  }
}

export const compactComposerIconButtonSx = {
  boxSizing: 'border-box',
  width: COMPACT_COMPOSER_CONTROL_SIZE,
  height: COMPACT_COMPOSER_CONTROL_SIZE,
  minWidth: COMPACT_COMPOSER_CONTROL_SIZE,
  minHeight: COMPACT_COMPOSER_CONTROL_SIZE,
  p: 0,
  flexShrink: 0
} as const
