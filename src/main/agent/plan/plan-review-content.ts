import type { PlanSpec, PlanStep } from '../../../shared/planRunTypes'
import { planStepAgent } from './model/plan-step-agent'
import { truncateUtf8 } from './model/utf8-truncate'

const MAX_STEP_REVIEW_BYTES = 2_000
const MAX_GOAL_REVIEW_BYTES = 8_000

function stepReview(step: PlanStep, index: number): string {
  const metadata = [
    `access: ${step.access}`,
    `depends on: ${step.dependsOn.join(', ') || 'none'}`,
    ...(step.hypothesisIds?.length ? [`hypotheses: ${step.hypothesisIds.join(', ')}`] : []),
    `agent: ${planStepAgent(step)}`
  ].join(' · ')
  const body = truncateUtf8(
    `${step.instructions}\n\nAcceptance: ${step.acceptance}`,
    MAX_STEP_REVIEW_BYTES
  )
  return `## ${index + 1}. ${step.title} (${step.id})\n\n${metadata}\n\n${body}`
}

function literatureReviewSummary(spec: PlanSpec): string[] {
  if (!spec.literatureReview) return []
  const status = spec.literatureReview.needed ? 'performed' : 'skipped'
  const refs = spec.literatureReview.references?.length
    ? ` (${spec.literatureReview.references.join('; ')})`
    : ''
  return [`Literature review (${status}): ${spec.literatureReview.rationale}${refs}`]
}

function hypothesesSummary(spec: PlanSpec): string[] {
  if (!spec.hypotheses?.length) return []
  const lines = spec.hypotheses.map((item) => {
    const marker = item.selected ? '[selected]' : '[unselected]'
    const criteria = item.testCriteria ? ` — test: ${item.testCriteria}` : ''
    return `- ${marker} ${item.id}: ${item.statement}${criteria}`
  })
  return [`## Hypotheses\n\n${lines.join('\n')}`]
}

export function planReviewContent(spec: PlanSpec): string {
  return [
    `# ${truncateUtf8(spec.goal, MAX_GOAL_REVIEW_BYTES)}`,
    ...(spec.researchQuestion ? [`Research question: ${spec.researchQuestion}`] : []),
    ...literatureReviewSummary(spec),
    ...hypothesesSummary(spec),
    ...spec.steps.map(stepReview)
  ].join('\n\n')
}
