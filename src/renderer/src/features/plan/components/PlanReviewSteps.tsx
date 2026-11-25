import { Box, Stack, Typography } from '@mui/material'

import type {
  PlanSpec,
  PlanStep,
  PlanStepInputContract,
  PlanStepVerificationCheck
} from '../../../../../shared/planRunTypes'
import { planCopy } from '../lib/planCopy'
import { PlanAccessMark } from './PlanAccessMark'
import { PlanTimelineStep } from './PlanTimeline'

function formatObjectiveCheck(check: PlanStepVerificationCheck): string {
  switch (check.kind) {
    case 'file_exists':
      return planCopy.checkFileExists(check.path)
    case 'non_empty_file':
      return planCopy.checkNonEmptyFile(check.path)
    case 'json_valid':
      return planCopy.checkJsonValid(check.path)
    case 'table_schema': {
      const parts: string[] = []
      if (check.format) parts.push(check.format.toUpperCase())
      if (check.minDataRows !== undefined) parts.push(`>=${check.minDataRows} rows`)
      if (check.minColumns !== undefined) parts.push(`>=${check.minColumns} cols`)
      if (check.requiredColumns?.length) parts.push(check.requiredColumns.join(', '))
      return planCopy.checkTableSchema(check.path, parts.join('; '))
    }
  }
}

function formatInputContract(contract: PlanStepInputContract): string {
  const rules: string[] = []
  if (contract.expectedReferenceAssembly) {
    rules.push(planCopy.contractExpectedReference(contract.expectedReferenceAssembly))
  }
  if (contract.mustMatchReferenceWith) {
    rules.push(planCopy.contractMatchReference(contract.mustMatchReferenceWith))
  }
  if (contract.requiredMatrixSemantics?.length) {
    rules.push(planCopy.contractMatrixSemantics(contract.requiredMatrixSemantics.join(', ')))
  }
  if (contract.requireSampleMatchWith) {
    rules.push(planCopy.contractMatchSamples(contract.requireSampleMatchWith))
  }
  if (contract.requireDonorMapping) {
    rules.push(planCopy.contractDonorMapping)
  }
  return rules.length > 0 ? `${contract.path} (${rules.join('; ')})` : contract.path
}

function PlanStepChecksAndContracts({ step }: { step: PlanStep }): React.JSX.Element {
  return (
    <>
      {step.checks?.length ? (
        <>
          <Typography variant="caption" sx={{ pt: 0.5, fontWeight: 700 }}>
            {planCopy.objectiveChecks}
          </Typography>
          <Box
            component="ul"
            data-phi-plan-step-checks={step.id}
            sx={{ m: 0, pl: 2, typography: 'body2' }}
          >
            {step.checks.map((check, checkIndex) => (
              <li key={`${check.kind}:${check.path}:${checkIndex}`}>
                {formatObjectiveCheck(check)}
              </li>
            ))}
          </Box>
        </>
      ) : null}
      {step.inputContracts?.length ? (
        <>
          <Typography variant="caption" sx={{ pt: 0.5, fontWeight: 700 }}>
            {planCopy.inputContracts}
          </Typography>
          <Box
            component="ul"
            data-phi-plan-step-input-contracts={step.id}
            sx={{ m: 0, pl: 2, typography: 'body2' }}
          >
            {step.inputContracts.map((contract, contractIndex) => (
              <li key={`${contract.path}:${contractIndex}`}>{formatInputContract(contract)}</li>
            ))}
          </Box>
        </>
      ) : null}
    </>
  )
}

function PlanReviewStep({
  step,
  index,
  isLast,
  stepNumbers
}: {
  step: PlanStep
  index: number
  isLast: boolean
  stepNumbers: ReadonlyMap<string, number>
}): React.JSX.Element {
  // Step ids are for the model; people read the plan by its numbering.
  const dependencies = step.dependsOn.map((id) => String(stepNumbers.get(id) ?? id))
  return (
    <Box component="li" sx={{ listStyle: 'none' }}>
      <PlanTimelineStep
        isLast={isLast}
        tone="pending"
        index={index}
        title={`${index + 1}. ${step.title}`}
        titleEnd={<PlanAccessMark access={step.access} />}
        meta={
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center' }}>
            {dependencies.length > 0 ? (
              <Typography variant="caption" color="text.secondary">
                {planCopy.dependencies(dependencies.join(', '))}
              </Typography>
            ) : null}
            {step.hypothesisIds?.length ? (
              <Typography
                variant="caption"
                color="text.secondary"
                data-phi-plan-step-hypotheses={step.id}
              >
                {planCopy.testsHypotheses(step.hypothesisIds.join(', '))}
              </Typography>
            ) : null}
            {step.agent ? (
              <Typography variant="caption" color="text.secondary">
                {planCopy.agent(step.agent)}
              </Typography>
            ) : null}
          </Stack>
        }
      >
        <Box component="details" data-phi-plan-step-details={step.id}>
          <Box
            component="summary"
            aria-label={planCopy.expandStepDetails(step.title)}
            sx={{ cursor: 'pointer', color: 'text.secondary', typography: 'caption' }}
          >
            {planCopy.stepDetails}
          </Box>
          <Stack spacing={0.5} sx={{ mt: 0.75 }}>
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
            <PlanStepChecksAndContracts step={step} />
          </Stack>
        </Box>
      </PlanTimelineStep>
    </Box>
  )
}

function PlanLiteratureReviewSection({
  review
}: {
  review: NonNullable<PlanSpec['literatureReview']>
}): React.JSX.Element {
  return (
    <Box data-phi-plan-literature-review sx={{ mb: 1 }}>
      <Typography variant="body2" component="p" sx={{ m: 0, whiteSpace: 'pre-wrap' }}>
        <strong>
          {review.needed ? planCopy.literatureReviewPerformed : planCopy.literatureReviewSkipped}
        </strong>{' '}
        {review.rationale}
        {review.references?.length ? ` (${review.references.join('; ')})` : ''}
        {review.verificationStatus
          ? ` [${review.verificationStatus === 'verified' ? planCopy.literatureVerified : planCopy.literatureUnverifiedOffline}]`
          : ''}
      </Typography>
      {review.databases?.length ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {planCopy.literatureSources(review.databases.join(', '))}
        </Typography>
      ) : null}
      {review.synthesis ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', whiteSpace: 'pre-wrap' }}
        >
          {planCopy.literatureSynthesis(review.synthesis)}
        </Typography>
      ) : null}
    </Box>
  )
}

function PlanHypothesesSection({
  hypotheses
}: {
  hypotheses: NonNullable<PlanSpec['hypotheses']>
}): React.JSX.Element {
  return (
    <Box data-phi-plan-hypotheses sx={{ mb: 1.25 }}>
      <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.25 }}>
        {planCopy.hypotheses}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2, typography: 'body2' }}>
        {hypotheses.map((hypothesis) => {
          const details = [
            hypothesis.statisticalUnit
              ? planCopy.hypothesisStatisticalUnit(hypothesis.statisticalUnit)
              : '',
            hypothesis.mechanism ? planCopy.hypothesisMechanism(hypothesis.mechanism) : '',
            hypothesis.prediction ? planCopy.hypothesisPrediction(hypothesis.prediction) : '',
            hypothesis.testCriteria ? planCopy.hypothesisTestCriteria(hypothesis.testCriteria) : '',
            hypothesis.falsificationCriteria
              ? planCopy.hypothesisFalsification(hypothesis.falsificationCriteria)
              : '',
            hypothesis.confounders?.length
              ? planCopy.hypothesisConfounders(hypothesis.confounders.join(', '))
              : ''
          ].filter(Boolean)
          return (
            <li key={hypothesis.id}>
              <strong>
                [{hypothesis.selected ? planCopy.hypothesisSelected : planCopy.hypothesisCandidate}]
              </strong>{' '}
              {hypothesis.id}: {hypothesis.statement}
              {details.length > 0 ? ` — ${details.join('; ')}` : ''}
            </li>
          )
        })}
      </Box>
    </Box>
  )
}

export function PlanReviewSteps({ plan }: { plan: PlanSpec }): React.JSX.Element {
  const stepNumbers = new Map(plan.steps.map((step, index) => [step.id, index + 1]))
  return (
    <>
      {plan.researchQuestion ? (
        <Typography variant="body2" component="p" sx={{ mb: 1, whiteSpace: 'pre-wrap' }}>
          <strong>{planCopy.researchQuestion}</strong> {plan.researchQuestion}
        </Typography>
      ) : null}
      {plan.literatureReview ? (
        <PlanLiteratureReviewSection review={plan.literatureReview} />
      ) : null}
      {plan.hypotheses?.length ? <PlanHypothesesSection hypotheses={plan.hypotheses} /> : null}
      <Box component="ol" data-phi-plan-steps sx={{ m: 0, p: 0, listStyle: 'none' }}>
        {plan.steps.map((step, index) => (
          <PlanReviewStep
            key={step.id}
            step={step}
            index={index}
            isLast={index === plan.steps.length - 1}
            stepNumbers={stepNumbers}
          />
        ))}
      </Box>
    </>
  )
}
