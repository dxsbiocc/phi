import { Button, IconButton, Stack } from '@mui/material'

import type { PlanRunTimelineSnapshot } from '../../../../../shared/planRunTypes'
import { PhiIcons } from '../../../icons'
import { planCopy } from '../lib/planCopy'

export function PlanRunControls({
  run,
  disabled,
  onPause,
  onResume,
  onStop
}: {
  run: PlanRunTimelineSnapshot
  disabled: boolean
  onPause: () => void
  onResume: () => void
  onStop: () => void
}): React.JSX.Element | null {
  const canPause = run.status === 'running'
  const canResume = run.status === 'paused' && run.pause?.reason === 'user'
  if (!canPause && !canResume) return null
  return (
    <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
      <Button
        size="small"
        variant="outlined"
        disabled={disabled}
        onClick={canPause ? onPause : onResume}
        aria-label={canPause ? planCopy.pause : planCopy.resume}
      >
        {canPause ? planCopy.pause : planCopy.resume}
      </Button>
      <IconButton
        size="small"
        color="error"
        disabled={disabled}
        onClick={onStop}
        aria-label={planCopy.stop}
      >
        <PhiIcons.action.stop size={16} aria-hidden />
      </IconButton>
    </Stack>
  )
}
