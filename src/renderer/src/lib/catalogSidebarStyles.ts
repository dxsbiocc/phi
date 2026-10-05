import { alpha, type Theme } from '@mui/material/styles'

export const catalogSidebarRowSx = {
  alignItems: 'center',
  mx: 0,
  my: 0.25,
  px: 1.5,
  py: 0.75,
  minHeight: 52,
  gap: 1.25,
  borderRadius: 1.25,
  border: '1px solid transparent',
  backgroundColor: 'transparent',
  transition: 'background-color 120ms ease, border-color 120ms ease',
  '&:hover': { backgroundColor: 'action.hover' },
  '&.Mui-selected': {
    backgroundColor: (theme: Theme) =>
      alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.08),
    borderColor: (theme: Theme) => alpha(theme.palette.primary.main, 0.24),
    boxShadow: 'none'
  },
  '&.Mui-selected:hover': {
    backgroundColor: (theme: Theme) =>
      alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.22 : 0.12)
  },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
} as const
