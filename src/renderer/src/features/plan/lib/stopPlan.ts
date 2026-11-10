import type { PlanRunsController } from '../hooks/usePlanRuns'

/** A replan is drafted by a conversation turn; stop that turn before stopping the plan. */
export async function stopPlan(
  controller: PlanRunsController,
  onStopTurn?: () => Promise<void>
): Promise<void> {
  if (controller.replanPending && onStopTurn) await onStopTurn().catch(() => undefined)
  await controller.stop()
}
