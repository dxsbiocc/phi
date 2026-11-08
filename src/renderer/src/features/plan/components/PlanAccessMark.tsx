import { Box, Tooltip } from '@mui/material'

import type { PlanStepAccess } from '../../../../../shared/planRunTypes'
import { PhiIcons } from '../../../icons'
import { planCopy } from '../lib/planCopy'

export function PlanAccessMark({ access }: { access: PlanStepAccess }): React.JSX.Element {
  const write = access === 'write'
  const Icon = write ? PhiIcons.tool.edit : PhiIcons.tool.read
  const label = write ? planCopy.accessWrite : planCopy.accessRead
  return (
    <Tooltip title={label} enterDelay={500}>
      <Box
        component="span"
        role="img"
        aria-label={label}
        sx={{
          width: 22,
          height: 22,
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          border: '1px solid',
          borderColor: write ? 'warning.main' : 'info.main',
          color: write ? 'warning.main' : 'info.main'
        }}
      >
        <Icon size={12} aria-hidden />
      </Box>
    </Tooltip>
  )
}
