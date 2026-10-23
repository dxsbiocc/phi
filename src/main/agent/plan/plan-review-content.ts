import type { PlanSpec, PlanStep } from '../../../shared/planRunTypes'
import { truncateUtf8 } from './model/utf8-truncate'

const MAX_STEP_REVIEW_BYTES = 2_000
const MAX_GOAL_REVIEW_BYTES = 8_000

function stepReview(step: PlanStep, index: number): string {
  const metadata = [
    `access: ${step.access}`,
    `depends on: ${step.dependsOn.join(', ') || 'none'}`,
    `agent: ${step.agent ?? 'PlanStep'}`
  ].join(' · ')
  const body = truncateUtf8(
    `${step.instructions}\n\nAcceptance: ${step.acceptance}`,
    MAX_STEP_REVIEW_BYTES
  )
  return `## ${index + 1}. ${step.title} (${step.id})\n\n${metadata}\n\n${body}`
}

export function planReviewContent(spec: PlanSpec): string {
  return [
    `# ${truncateUtf8(spec.goal, MAX_GOAL_REVIEW_BYTES)}`,
    ...spec.steps.map(stepReview)
  ].join('\n\n')
}
