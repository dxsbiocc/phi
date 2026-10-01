import { Box } from '@mui/material'
import { alpha } from '@mui/material/styles'

type TabCountTone = 'neutral' | 'success' | 'warning' | 'error'

// Soft badge for tab counts, after the Minimal reference: light tint + dark-shade text.
export function TabCountBadge({
  count,
  tone = 'neutral'
}: {
  count: number
  tone?: TabCountTone
}): React.JSX.Element {
  return (
    <Box
      component="span"
      sx={(theme) => {
        const isDark = theme.palette.mode === 'dark'
        const colors =
          tone === 'neutral'
            ? {
                bgcolor: alpha(theme.palette.grey[500], 0.16),
                color: isDark ? theme.palette.grey[300] : theme.palette.grey[700]
              }
            : {
                bgcolor: alpha(theme.palette[tone].main, 0.16),
                color: isDark ? theme.palette[tone].light : theme.palette[tone].dark
              }
        return {
          minWidth: 20,
          height: 20,
          px: 0.75,
          borderRadius: 0.75,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1,
          ...colors
        }
      }}
    >
      {count}
    </Box>
  )
}

export function TabLabel({
  text,
  count,
  tone
}: {
  text: string
  count: number
  tone?: TabCountTone
}): React.JSX.Element {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
      {text}
      <TabCountBadge count={count} tone={tone} />
    </Box>
  )
}
