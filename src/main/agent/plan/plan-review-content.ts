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
  const parts = [`Literature review (${status}): ${spec.literatureReview.rationale}`]
  if (spec.literatureReview.verificationStatus) {
    parts.push(`Verification: ${spec.literatureReview.verificationStatus}`)
  }
  if (spec.literatureReview.databases?.length) {
    parts.push(`Sources: ${spec.literatureReview.databases.join(', ')}`)
  }
  if (spec.literatureReview.synthesis) {
    parts.push(`Synthesis: ${spec.literatureReview.synthesis}`)
  }
  if (spec.literatureReview.references?.length) {
    parts.push(`References: ${spec.literatureReview.references.join('; ')}`)
  }
  return [parts.join(' | ')]
}

function hypothesesSummary(spec: PlanSpec): string[] {
  if (!spec.hypotheses?.length) return []
  const lines = spec.hypotheses.map((item) => {
    const marker = item.selected ? '[selected]' : '[unselected]'
    const details: string[] = []
    if (item.statisticalUnit) details.push(`unit: ${item.statisticalUnit}`)
    if (item.mechanism) details.push(`mechanism: ${item.mechanism}`)
    if (item.prediction) details.push(`prediction: ${item.prediction}`)
    if (item.testCriteria) details.push(`test: ${item.testCriteria}`)
    if (item.falsificationCriteria) details.push(`falsification: ${item.falsificationCriteria}`)
    if (item.confounders?.length) details.push(`confounders: ${item.confounders.join(', ')}`)
    return details.length > 0
      ? `- ${marker} ${item.id}: ${item.statement} — ${details.join('; ')}`
      : `- ${marker} ${item.id}: ${item.statement}`
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
