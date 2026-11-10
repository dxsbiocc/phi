import type { ReactNode } from 'react'
import { Box, type BoxProps } from '@mui/material'

/**
 * The colored square that leads a side-panel card. Kept purely visual so the
 * Background Jobs rows and system messages render the same tile.
 */
export function SidePanelIconTile({
  backgroundColor,
  foregroundColor = '#fff',
  children,
  sx,
  ...boxProps
}: Omit<BoxProps, 'children'> & {
  backgroundColor: string
  foregroundColor?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      {...boxProps}
      aria-hidden
      sx={[
        {
          width: 36,
          height: 36,
          borderRadius: 1.5,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          bgcolor: backgroundColor,
          color: foregroundColor
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : [])
      ]}
    >
      {children}
    </Box>
  )
}
