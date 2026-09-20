import { Box, type SxProps, type Theme } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { ReactNode } from 'react'

export function TimelineRail({
  children,
  active = false,
  sx
}: {
  children: ReactNode
  active?: boolean
  sx?: SxProps<Theme>
}): React.JSX.Element {
  const railSx: SxProps<Theme> = (theme) => {
    const quietRail = alpha(
      theme.palette.text.secondary,
      theme.palette.mode === 'dark' ? 0.2 : 0.16
    )
    const activeRail = alpha(
      theme.palette.primary.main,
      theme.palette.mode === 'dark' ? 0.52 : 0.42
    )
    const glow = alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.1)

    return {
      ml: 2.5,
      pl: 1.75,
      minWidth: 0,
      position: 'relative',
      '&::before': {
        content: '""',
        position: 'absolute',
        top: 6,
        bottom: 8,
        left: 0,
        width: 2,
        borderRadius: 999,
        background: active
          ? `linear-gradient(180deg, transparent 0%, ${quietRail} 12%, ${activeRail} 44%, ${activeRail} 62%, ${quietRail} 88%, transparent 100%)`
          : `linear-gradient(180deg, transparent 0%, ${quietRail} 14%, ${quietRail} 86%, transparent 100%)`,
        boxShadow: active ? `0 0 12px ${glow}` : 'none'
      }
    }
  }

  const mergedSx = [railSx, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])] as SxProps<Theme>

  return <Box sx={mergedSx}>{children}</Box>
}
