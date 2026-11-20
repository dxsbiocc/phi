import {
  isResearchPause,
  type PlanRunState,
  type ResearchPlanPausedEvent
} from '../../../shared/planRunTypes'
import { readScientificHandoff } from '../agents/research-handoff'
import { RESEARCH_RESULT_REVIEW } from '../agents/leader-prompt'

export function researchPlanPause(state: PlanRunState): ResearchPlanPausedEvent | undefined {
  const { pause } = state
  const question = state.spec.researchQuestion
  if (
    !isResearchPause(state) ||
    !question ||
    !pause?.stepId ||
    (pause.reason !== 'needs_input' && pause.reason !== 'step_failed')
  )
    return undefined
  const step = state.steps[pause.stepId]
  if (step?.status !== 'failed') return undefined
  const report =
    step.report && readScientificHandoff(step.report.text, question, step.report.status)
  return {
    type: 'research_plan_paused',
    runId: state.id,
    stepId: pause.stepId,
    attempt: step.attempts,
    reason: pause.reason,
    originalQuestion: question,
    ...(report?.structured ? { report: report.text } : {})
  }
}

export function sameResearchPause(
  left: ResearchPlanPausedEvent,
  right: ResearchPlanPausedEvent
): boolean {
  return (
    left.runId === right.runId && left.stepId === right.stepId && left.attempt === right.attempt
  )
}

export function researchPlanPausePrompt(event: ResearchPlanPausedEvent): string {
  return [
    '<phi_research_plan_paused>',
    'Phi paused this research stage. This notice is not a user request or a finished plan.',
    JSON.stringify({
      runId: event.runId,
      stepId: event.stepId,
      attempt: event.attempt,
      reason: event.reason,
      originalQuestion: event.originalQuestion
    }),
    event.report ?? 'No verified scientific handoff is available for this attempt.',
    RESEARCH_RESULT_REVIEW,
    'Explain the gap and any available evidence now. If the user can resolve it, ask a focused question with actionable choices. Keep the paused step paused; do not resubmit it, change methods, or invent a missing result.',
    'Reply in the language the user has been using.',
    '</phi_research_plan_paused>'
  ].join('\n')
}
