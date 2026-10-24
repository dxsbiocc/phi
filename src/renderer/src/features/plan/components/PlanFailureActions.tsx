import { Button, Stack, Typography } from '@mui/material'

import type { PlanRunPause } from '../../../../../shared/planRunTypes'

import { planCopy } from '../lib/planCopy'

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
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button
          size="small"
          variant="outlined"
          disabled={disabled}
          onClick={onRetry}
          aria-label={planCopy.retry}
        >
          {planCopy.retry}
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={disabled}
          onClick={onSkip}
          aria-label={planCopy.skip}
        >
          {planCopy.skip}
        </Button>
        {onReplan ? (
          <Button
            size="small"
            variant="outlined"
            disabled={disabled}
            onClick={onReplan}
            aria-label={planCopy.replanRemaining}
          >
            {planCopy.replanRemaining}
          </Button>
        ) : null}
        <Button
          size="small"
          color="error"
          disabled={disabled}
          onClick={onStop}
          aria-label={planCopy.stop}
        >
          {planCopy.stop}
        </Button>
      </Stack>
      {onReplan ? (
        <Typography variant="caption" color="text.secondary">
          {planCopy.replanReviewNotice}
        </Typography>
      ) : null}
    </Stack>
  )
}
