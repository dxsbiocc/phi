import {
  PLAN_DEFAULT_STEP_AGENT,
  type PlanSpec,
  type PlanStep
} from '../../../../shared/planRunTypes'

export { PLAN_DEFAULT_STEP_AGENT }

/** The registry agent that runs a plan step when the step omits `agent`. */
export function planStepAgent(step: Pick<PlanStep, 'agent'>): string {
  return step.agent ?? PLAN_DEFAULT_STEP_AGENT
}

/**
 * Rejects steps whose agent the session cannot start, naming every agent it can start so
 * the planning model can correct all steps in one retry.
 */
export function unavailablePlanAgents(
  spec: PlanSpec,
  available: ReadonlyMap<string, unknown> | undefined
): string[] {
  const names = [...(available?.keys() ?? [])].sort((left, right) => left.localeCompare(right))
  const availableNames = names.length > 0 ? names.join(', ') : 'none'
  return spec.steps.flatMap((step) => {
    const agent = planStepAgent(step)
    return names.includes(agent)
      ? []
      : [
          `step "${step.id}".agent "${agent}" is not available. Available agents: ${availableNames}.`
        ]
  })
}
