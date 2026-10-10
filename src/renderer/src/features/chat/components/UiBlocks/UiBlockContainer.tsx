import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'

export function UiBlockContainer({
  title,
  children
}: {
  title?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      sx={{
        minWidth: 0,
        overflow: 'hidden',
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        bgcolor: 'background.paper',
        '@container phi-chat (max-width: 560px)': { borderRadius: 1.5 }
      }}
    >
      {title ? (
        <Typography
          variant="subtitle2"
          sx={{
            px: 1.5,
            pt: 1.25,
            pb: 0.75,
            fontWeight: 700,
            '@container phi-chat (max-width: 560px)': { px: 1, pt: 0.75, pb: 0.5 }
          }}
        >
          {title}
        </Typography>
      ) : null}
      {children}
    </Box>
  )
}
