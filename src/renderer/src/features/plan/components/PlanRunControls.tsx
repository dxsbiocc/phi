import { Stack } from '@mui/material'

import type { PlanRunTimelineSnapshot } from '../../../../../shared/planRunTypes'
import { LabeledIconButton } from '../../../components/LabeledIconButton'
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
      <LabeledIconButton
        label={canPause ? planCopy.pause : planCopy.resume}
        size="small"
        color="primary"
        disabled={disabled}
        onClick={canPause ? onPause : onResume}
      >
        {canPause ? (
          <PhiIcons.action.pause size={16} aria-hidden />
        ) : (
          <PhiIcons.action.play size={16} aria-hidden />
        )}
      </LabeledIconButton>
      <LabeledIconButton
        label={planCopy.stop}
        size="small"
        color="error"
        disabled={disabled}
        onClick={onStop}
      >
        <PhiIcons.action.stop size={16} aria-hidden />
      </LabeledIconButton>
    </Stack>
  )
}
