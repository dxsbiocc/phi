import type { PlanRunState, PlanSpec } from '../../../../shared/planRunTypes'
import type { AgentRunAdmission, AgentRunListener, AgentRunSnapshot } from '../../agents/registry'

/**
 * Electron-free ownership hooks supplied only by the unified kernel adapter.
 * The legacy desktop worker omits them and keeps its existing host services.
 */
export interface KernelAgentRunRuntime {
  admission(sessionId: string): AgentRunAdmission
  listener(sessionId: string): AgentRunListener
}

export interface KernelPlanRuntime {
  approved(sessionId: string, spec: PlanSpec, replanRequestId?: string): Promise<PlanRunState>
  cancelled(sessionId: string, replanRequestId?: string): void
}

export interface KernelRuntimeServices {
  agentRuns?: KernelAgentRunRuntime
  plans?: KernelPlanRuntime
}

export type KernelAgentRunRuntimeSnapshot = AgentRunSnapshot
