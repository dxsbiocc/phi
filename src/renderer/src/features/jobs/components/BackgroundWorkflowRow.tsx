import { Box, ButtonBase, Collapse, Stack, Typography } from '@mui/material'

import { useUiLanguage } from '../../../lib/i18n'
import { PhiIcons } from '../../../icons'
import type { BackgroundJobDisplayItem } from '../lib/backgroundJobGroups'
import { jobsCopy } from '../lib/jobsCopy'
import { BackgroundJobIcon } from './BackgroundJobIcon'

type Workflow = Extract<BackgroundJobDisplayItem, { kind: 'workflow' }>

export function BackgroundWorkflowRow({
  workflow,
  expanded,
  onToggle,
  renderChild
}: {
  workflow: Workflow
  expanded: boolean
  onToggle: () => void
  renderChild: (job: Workflow['jobs'][number]) => React.ReactNode
}): React.JSX.Element {
  useUiLanguage()
  const completed = workflow.jobs.filter((job) => job.run.state === 'completed').length
  const failed = workflow.jobs.filter((job) => ['failed', 'lost'].includes(job.run.state)).length
  const onSlurm = workflow.jobs.some((job) =>
    ['slurm', 'slurm-controller'].includes(job.run.executor)
  )
  const waiting = workflow.active && !workflow.jobs.some((job) => job.active)
  const ToggleIcon = expanded ? PhiIcons.action.collapse : PhiIcons.action.expand
  return (
    <Box data-phi-background-workflow={workflow.key} sx={{ mb: 0.9, minWidth: 0 }}>
      <ButtonBase
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={workflow.title}
        sx={{
          width: '100%',
          minHeight: 68,
          p: 1,
          gap: 1,
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          bgcolor: 'background.paper',
          boxShadow: '0 2px 5px rgba(18, 35, 43, 0.05), 0 8px 20px rgba(18, 35, 43, 0.04)',
          textAlign: 'left',
          justifyContent: 'flex-start'
        }}
      >
        <BackgroundJobIcon kind="wrapper" />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap title={workflow.title}>
            {workflow.title}
          </Typography>
          <Stack direction="row" spacing={0.75} sx={{ minWidth: 0, color: 'text.secondary' }}>
            <Typography variant="caption" noWrap>
              {workflow.expectedSteps === undefined
                ? jobsCopy.workflowCompletedSteps(completed)
                : jobsCopy.workflowProgress(completed, workflow.expectedSteps)}
            </Typography>
            {failed > 0 && (
              <Typography variant="caption" color="error.main">
                {jobsCopy.workflowFailed(failed)}
              </Typography>
            )}
            {onSlurm && <Typography variant="caption">{jobsCopy.workflowSlurm}</Typography>}
            {waiting && <Typography variant="caption">{jobsCopy.workflowWaiting}</Typography>}
          </Stack>
        </Box>
        <ToggleIcon size={16} />
      </ButtonBase>
      <Collapse in={expanded} unmountOnExit>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
            mt: 0.5,
            ml: 2.25,
            pl: 1.25,
            borderLeft: 1,
            borderColor: 'divider'
          }}
        >
          {workflow.jobs.map((job) => (
            <Box key={job.key}>{renderChild(job)}</Box>
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}
