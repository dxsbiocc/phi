import { Button, Stack } from '@mui/material'

import { planCopy } from '../lib/planCopy'

export function PlanFailureActions({
  disabled,
  onRetry,
  onSkip,
  onStop
}: {
  disabled: boolean
  onRetry: () => void
  onSkip: () => void
  onStop: () => void
}): React.JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
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
  )
}
