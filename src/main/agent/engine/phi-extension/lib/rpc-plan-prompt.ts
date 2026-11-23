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
    return 'For every research or data-analysis task, always plan and generate candidate hypotheses first: call enter_plan_mode alone with execute=false for markdown plan review, or alone with execute=true for structured verifiable steps. Only trivial single-fact questions or tiny edits may skip planning. Never batch this call with another tool. Both paths require read-only investigation, hypothesis selection, and explicit user review before implementation.'
  if (mode === 'plan' && installed(RPC_MARKDOWN_PLAN_PROPOSAL_TOOL))
    return 'Plan review mode is active. Investigate read-only, decide whether prior literature retrieval is needed (do not retrieve literature blindly for every question), formulate 2–4 testable candidate hypotheses and ask the user to select via ask_user_question before drafting the plan. Then write only the session-local local://PLAN.md draft aligned to the selected hypotheses and call propose_plan_markdown with a short title only. Do not implement until the review decision permits it.'
  if (mode === 'plan_execute' && installed('propose_plan_steps'))
    return 'Structured planning and execution mode is active. Investigate read-only, judge whether prior literature retrieval is needed for this task (skip when unnecessary and record rationale in literatureReview), generate 2–4 testable candidate hypotheses and ask the user to select via ask_user_question before proposing the plan, then call propose_plan_steps with literatureReview, hypotheses (marking selected=true), and steps linked via hypothesisIds. Do not edit files or start work before review.'
  return undefined
}
