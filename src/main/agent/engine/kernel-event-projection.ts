import type { JsonValue, KernelEventFrame } from '../../../shared/kernel-protocol'
import { phiEventFromWire } from './events'
import type { PhiAgentEvent } from './types'
import {
  approvalFromEvent,
  stateFromKernel,
  stringValue,
  type SessionBinding
} from './kernel-session-support'

export function projectKernelEvent(
  binding: SessionBinding,
  event: KernelEventFrame,
  payload: Record<string, JsonValue> | undefined
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
    const { event: planEvent, ...rendererPayload } = payload
    binding.sink.event({
      type: stringValue(planEvent) ?? 'plan_run_updated',
      ...rendererPayload
    } as PhiAgentEvent)
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
