import { RPC_MARKDOWN_PLAN_PROPOSAL_TOOL } from './rpc-prompt-policy'
import { RPC_ENTER_PLAN_MODE_TOOL } from './rpc-plan-phase'

export function rpcWorkModePrompt(
  mode: 'auto' | 'direct' | 'plan' | 'plan_execute' | undefined,
  activeTools: readonly string[],
  hostTools: readonly string[]
): string | undefined {
  const installed = (name: string): boolean =>
    activeTools.includes(name) && hostTools.includes(name)
  if (mode === 'auto' && installed(RPC_ENTER_PLAN_MODE_TOOL))
    return 'Choose the lightest suitable path. For broad, unclear, or risky work, call enter_plan_mode alone with execute=false and a short reason. For work with independent steps, call it alone with execute=true. Never batch this call with another tool. Both paths require read-only investigation and explicit user review before implementation.'
  if (mode === 'plan' && installed(RPC_MARKDOWN_PLAN_PROPOSAL_TOOL))
    return 'Plan review mode is active. Investigate with read-only tools. Write or edit only the session-local local://PLAN.md draft, then call propose_plan_markdown with a short title only. Phi reads the draft from this session and asks the user to review it. Do not implement until the review decision permits it.'
  if (mode === 'plan_execute' && installed('propose_plan_steps'))
    return 'Structured planning and execution mode is active. Investigate with read-only tools, then call propose_plan_steps with the complete structured plan for user review. Do not edit files or start work before review.'
  return undefined
}
