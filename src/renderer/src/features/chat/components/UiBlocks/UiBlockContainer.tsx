import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'

export function UiBlockContainer({
  title,
  children,
  framed = true
}: {
  title?: string
  children: ReactNode
  framed?: boolean
}): React.JSX.Element {
  return (
    <Box sx={{ minWidth: 0 }}>
      {title ? (
        <Typography
          variant="subtitle2"
          sx={{
            mb: 0.75,
            fontWeight: 700,
            '@container phi-chat (max-width: 560px)': { mb: 0.5 }
          }}
        >
          {title}
        </Typography>
      ) : null}
      {framed ? (
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
          {children}
        </Box>
      ) : (
        children
      )}
    </Box>
  )
}
