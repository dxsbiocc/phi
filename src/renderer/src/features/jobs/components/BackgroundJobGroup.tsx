import { Box, ButtonBase, Collapse, Stack, Typography } from '@mui/material'

import { PhiIcons } from '../../../icons'
import { workspacePanelText } from '../../../layout'

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
      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          alignItems: 'center',
          width: '100%',
          minWidth: 0,
          minHeight: 40,
          boxSizing: 'border-box',
          px: 0.75,
          borderRadius: 1
        }}
      >
        <ButtonBase
          disableRipple
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          sx={{
            flex: 1,
            minWidth: 0,
            alignSelf: 'stretch',
            justifyContent: 'flex-start',
            gap: 0.75,
            px: 0.5,
            py: 0.5,
            borderRadius: 1,
            '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' }
          }}
        >
          {expanded ? <CollapseIcon size={16} /> : <ExpandIcon size={16} />}
          <Typography variant="subtitle2" sx={workspacePanelText.section}>
            {title}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={workspacePanelText.body}>
            {count}
          </Typography>
        </ButtonBase>
        {action}
      </Stack>
      <Collapse in={expanded} id={contentId}>
        <Box sx={{ pt: 0.75, px: 0.5 }}>{children}</Box>
      </Collapse>
    </Box>
  )
}
