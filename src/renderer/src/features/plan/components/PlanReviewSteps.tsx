import { Box, Chip, Stack, Typography } from '@mui/material'

import type { PlanSpec, PlanStep } from '../../../../../shared/planRunTypes'
import { planCopy } from '../lib/planCopy'

function PlanReviewStep({
  step,
  index,
  stepNumbers
}: {
  step: PlanStep
  index: number
  stepNumbers: ReadonlyMap<string, number>
}): React.JSX.Element {
  // Step ids are for the model; people read the plan by its numbering.
  const dependencies = step.dependsOn.map((id) => String(stepNumbers.get(id) ?? id))
  return (
    <Box component="li" sx={{ py: 0.75, '& + &': { borderTop: 1, borderColor: 'divider' } }}>
      <Stack
        direction="row"
        spacing={0.75}
        useFlexGap
        sx={{ alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Typography variant="body2" sx={{ minWidth: 0, fontWeight: 600 }}>
          {index + 1}. {step.title}
        </Typography>
        <Chip size="small" variant="outlined" label={planCopy[step.access]} />
        {dependencies.length > 0 ? (
          <Typography variant="caption" color="text.secondary">
            {planCopy.dependencies(dependencies.join(', '))}
          </Typography>
        ) : null}
        {step.agent ? (
          <Typography variant="caption" color="text.secondary">
            {planCopy.agent(step.agent)}
          </Typography>
        ) : null}
      </Stack>
      <Box component="details" data-phi-plan-step-details={step.id} sx={{ mt: 0.5 }}>
        <Box
          component="summary"
          aria-label={planCopy.expandStepDetails(step.title)}
          sx={{ cursor: 'pointer', color: 'text.secondary', typography: 'caption' }}
        >
          {planCopy.stepDetails}
        </Box>
        <Stack spacing={0.5} sx={{ mt: 0.5, pl: 1.5 }}>
          <Typography variant="caption" sx={{ fontWeight: 700 }}>
            {planCopy.instructions}
          </Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            {step.instructions}
          </Typography>
          <Typography variant="caption" sx={{ pt: 0.5, fontWeight: 700 }}>
            {planCopy.acceptanceCriteria}
          </Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            {step.acceptance}
          </Typography>
        </Stack>
      </Box>
    </Box>
  )
}

export function PlanReviewSteps({ plan }: { plan: PlanSpec }): React.JSX.Element {
  const stepNumbers = new Map(plan.steps.map((step, index) => [step.id, index + 1]))
  return (
    <Box component="ol" data-phi-plan-steps sx={{ m: 0, p: 0, listStyle: 'none' }}>
      {plan.steps.map((step, index) => (
        <PlanReviewStep key={step.id} step={step} index={index} stepNumbers={stepNumbers} />
      ))}
    </Box>
  )
}
