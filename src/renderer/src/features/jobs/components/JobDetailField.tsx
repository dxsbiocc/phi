import { Box, Typography } from '@mui/material'

export function JobDetailField({
  label,
  value,
  mono = false,
  scroll = false
}: {
  label: string
  value: string
  mono?: boolean
  scroll?: boolean
}): React.JSX.Element {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.35 }}>
        {label}
      </Typography>
      <Typography
        component={mono ? 'pre' : 'div'}
        variant="body2"
        sx={{
          m: 0,
          minWidth: 0,
          maxHeight: scroll ? 240 : undefined,
          overflowY: scroll ? 'auto' : undefined,
          overflowWrap: 'anywhere',
          whiteSpace: mono ? 'pre-wrap' : 'normal',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          userSelect: 'text'
        }}
      >
        {value}
      </Typography>
    </Box>
  )
}
