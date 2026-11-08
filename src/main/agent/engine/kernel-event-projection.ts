import type { JsonValue, KernelEventFrame } from '../../../shared/kernel-protocol'
import type { PlanRunFinishedEvent, PlanRunState } from '../../../shared/planRunTypes'
import { phiEventFromWire } from './events'
import type { PhiAgentEvent } from './types'
import {
  approvalFromEvent,
  stateFromKernel,
  stringValue,
  type SessionBinding
} from './kernel-session-support'

function phiSessionIdForBinding(binding: SessionBinding): string {
  return (
    binding.params.remoteProject?.phiSessionId ??
    binding.params.phiSessionId ??
    binding.logicalSessionId
  )
}

function planRunFinishedEvent(state: JsonValue | undefined): PlanRunFinishedEvent | null {
  if (state === undefined || state === null || typeof state !== 'object' || Array.isArray(state)) {
    return null
  }
  const runId = (state as { id?: unknown }).id
  if (typeof runId !== 'string' || !runId) return null
  return { type: 'plan_run_finished', runId, state: state as unknown as PlanRunState }
}

function projectPlanRunEvent(
  binding: SessionBinding,
  payload: Record<string, JsonValue>,
  onPlanRunFinished?: (phiSessionId: string, event: PlanRunFinishedEvent) => void
): void {
  const { event: planEvent, fullState, ...rendererPayload } = payload
  const type = stringValue(planEvent) ?? 'plan_run_updated'
  if (type === 'plan_run_finished' && onPlanRunFinished) {
    const finished = planRunFinishedEvent(fullState)
    if (finished) onPlanRunFinished(phiSessionIdForBinding(binding), finished)
  }
  binding.sink.event({ type, ...rendererPayload } as PhiAgentEvent)
}

export function projectKernelEvent(
  binding: SessionBinding,
  event: KernelEventFrame,
  payload: Record<string, JsonValue> | undefined,
  onPlanRunFinished?: (phiSessionId: string, event: PlanRunFinishedEvent) => void
): void {
  if (event.type === 'session.event') {
    const projected = phiEventFromWire(event.payload)
    if (projected) binding.sink.event(projected)
    return
  }
  if (event.type === 'session.state') {
    binding.state = stateFromKernel(event.payload, binding)
    binding.sink.state(structuredClone(binding.state))
    return
  }
  if (event.type === 'approval.requested' && payload) {
    const approval = approvalFromEvent(payload)
    if (approval) binding.sink.approval?.(approval)
    return
  }
  if (event.type === 'agentRun.started') binding.activeAgentRuns += 1
  if (event.type === 'agentRun.finished') {
    binding.activeAgentRuns = Math.max(0, binding.activeAgentRuns - 1)
  }
  if (event.type === 'planRun.updated' && payload) {
    projectPlanRunEvent(binding, payload, onPlanRunFinished)
    return
  }
  // agentRun.finished is not forwarded: the agent-run host already records the finish on the
  // conversation under the run's display name, and a second copy showed as a duplicate notice.
  const mapped: Record<string, string> = {
    'agentRun.started': 'agent_run_started',
    'agentRun.step': 'agent_run_step',
    'agentRun.reported': 'agent_run_reported',
    'interaction.cancelled': 'interaction_cancelled',
    'models.changed': 'model_changed'
  }
  const type = mapped[event.type]
  if (type) binding.sink.event({ type, ...(payload ?? {}) } as PhiAgentEvent)
}
