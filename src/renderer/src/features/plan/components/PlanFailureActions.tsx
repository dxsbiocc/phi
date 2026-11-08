import { IconButton, Stack, Typography } from '@mui/material'

import type { PlanRunPause } from '../../../../../shared/planRunTypes'
import { PhiIcons } from '../../../icons'

import { planCopy } from '../lib/planCopy'

const roundActionSx = {
  width: 28,
  height: 28,
  border: '1px solid',
  borderColor: 'currentColor'
} as const

export function PlanFailureActions({
  disabled,
  reason,
  onRetry,
  onSkip,
  onReplan,
  onStop
}: {
  disabled: boolean
  reason: PlanRunPause['reason']
  onRetry: () => void
  onSkip: () => void
  onReplan?: () => void
  onStop: () => void
}): React.JSX.Element {
  return (
    <Stack spacing={0.75} sx={{ mt: 1 }}>
      <Typography variant="caption" color="text.secondary">
        {reason === 'needs_input'
          ? planCopy.needsInputRecovery
          : reason === 'interrupted'
            ? planCopy.interruptedRecovery
            : planCopy.failedRecovery}
      </Typography>
      <Stack
        direction="row"
        spacing={0.75}
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'center' }}
      >
        <IconButton
          size="small"
          color="primary"
          disabled={disabled}
          onClick={onRetry}
          aria-label={planCopy.retry}
          sx={roundActionSx}
        >
          <PhiIcons.action.refresh size={15} aria-hidden />
        </IconButton>
        <IconButton
          size="small"
          color="primary"
          disabled={disabled}
          onClick={onSkip}
          aria-label={planCopy.skip}
          sx={roundActionSx}
        >
          <PhiIcons.action.skip size={15} aria-hidden />
        </IconButton>
        {onReplan ? (
          <IconButton
            size="small"
            color="primary"
            disabled={disabled}
            onClick={onReplan}
            aria-label={planCopy.replanRemaining}
            sx={roundActionSx}
          >
            <PhiIcons.action.replan size={15} aria-hidden />
          </IconButton>
        ) : null}
        <IconButton
          size="small"
          color="error"
          disabled={disabled}
          onClick={onStop}
          aria-label={planCopy.stop}
          sx={roundActionSx}
        >
          <PhiIcons.action.stop size={14} aria-hidden />
        </IconButton>
      </Stack>
      {onReplan ? (
        <Typography variant="caption" color="text.secondary">
          {planCopy.replanReviewNotice}
        </Typography>
      ) : null}
    </Stack>
  )
}
