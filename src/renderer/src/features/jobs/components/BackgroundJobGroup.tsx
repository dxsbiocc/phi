import { Box, ButtonBase, Collapse, Stack, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'

const ExpandIcon = PhiIcons.action.expand
const CollapseIcon = PhiIcons.action.collapse

/** A titled, collapsible section of the jobs list. */
export function BackgroundJobGroup({
  id,
  title,
  count,
  expanded,
  onToggle,
  action,
  children
}: {
  id: string
  title: string
  count: number
  expanded: boolean
  onToggle: () => void
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const contentId = `background-job-group-${id}`
  return (
    <Box data-phi-background-job-group={id} sx={{ minWidth: 0, mb: 1 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
        <ButtonBase
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          sx={{
            flex: 1,
            minWidth: 0,
            justifyContent: 'flex-start',
            gap: 0.75,
            px: 0.5,
            py: 0.5,
            borderRadius: 1,
            '&:hover': { bgcolor: 'action.hover' },
            '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' }
          }}
        >
          {expanded ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
          <Typography variant="caption" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {count}
          </Typography>
        </ButtonBase>
        {action}
      </Stack>
      <Collapse in={expanded} id={contentId}>
        <Box sx={{ pt: 0.75 }}>{children}</Box>
      </Collapse>
    </Box>
  )
}
