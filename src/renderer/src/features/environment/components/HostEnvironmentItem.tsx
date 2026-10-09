import type { ReactNode } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Collapse from '@mui/material/Collapse'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

type HostEnvironmentItemProps = {
  id: string
  icon: ReactNode
  title: string
  summary: string
  status: {
    label: string
    color: 'success' | 'warning' | 'default'
  }
  contextLabel?: string
  action?: ReactNode
  expanded?: boolean
  details?: ReactNode
}

export function HostEnvironmentItem({
  id,
  icon,
  title,
  summary,
  status,
  contextLabel,
  action,
  expanded = false,
  details
}: HostEnvironmentItemProps): React.JSX.Element {
  return (
    <Paper
      component="article"
      variant="outlined"
      data-phi-host-environment-item={id}
      sx={{ minWidth: 0, overflow: 'hidden', borderRadius: 2 }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minHeight: 76, p: 1.5 }}>
        <Box
          aria-hidden
          sx={{
            width: 42,
            height: 42,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 1.5,
            color: 'primary.main',
            bgcolor: 'action.hover'
          }}
        >
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack
            direction="row"
            spacing={0.75}
            useFlexGap
            sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
          >
            <Typography variant="body1" sx={{ fontWeight: 700 }}>
              {title}
            </Typography>
            <Chip size="small" color={status.color} variant="outlined" label={status.label} />
            {contextLabel ? <Chip size="small" variant="outlined" label={contextLabel} /> : null}
          </Stack>
          <Typography
            variant="body2"
            color="text.secondary"
            noWrap
            title={summary}
            sx={{ mt: 0.25 }}
          >
            {summary}
          </Typography>
        </Box>
        {action ? <Box sx={{ flexShrink: 0 }}>{action}</Box> : null}
      </Stack>
      {details ? (
        <Collapse in={expanded} unmountOnExit>
          <Box sx={{ px: 1.5, py: 1.5, borderTop: 1, borderColor: 'divider' }}>{details}</Box>
        </Collapse>
      ) : null}
    </Paper>
  )
}
