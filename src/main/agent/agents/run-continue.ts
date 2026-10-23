import type { AgentRunEndState, AgentRunFinishedEvent } from '../../../shared/agentRunNotice'
import type { WrapperRunFinishedEvent } from '../../../shared/wrapperRunNotice'
import type { PlanRunFinishedEvent, PlanRunState } from '../../../shared/planRunTypes'
import {
  MAX_AUTOMATIC_CONTINUATIONS,
  wrapperRunContinuationPrompt
} from '../wrappers/composition/job-continue'

/**
 * When a background agent run ends, Phi can wake the conversation that started
 * it so the main agent carries on with the report without the user asking. This
 * is the policy (should we?) and the message (what does the model read?); the
 * plumbing that submits the prompt lives in the main process and is shared with
 * background wrapper runs, so the two count against one wake-up cap.
 */

export type ContinuationEvent =
  WrapperRunFinishedEvent | AgentRunFinishedEvent | PlanRunFinishedEvent

export type AgentContinueDecision =
  { continue: true } | { continue: false; reason: 'cancelled' | 'limit' }

export function shouldContinueAfterAgentRun(input: {
  state: AgentRunEndState
  /** Automatic wake-ups since the user last wrote in this conversation. */
  automaticCount: number
}): AgentContinueDecision {
  // A cancel is somebody's own doing; there is nothing new for the agent to react to.
  if (input.state === 'cancelled') return { continue: false, reason: 'cancelled' }
  if (input.automaticCount >= MAX_AUTOMATIC_CONTINUATIONS) {
    return { continue: false, reason: 'limit' }
  }
  return { continue: true }
}

export function shouldContinueAfterPlanRun(automaticCount: number): AgentContinueDecision {
  return automaticCount >= MAX_AUTOMATIC_CONTINUATIONS
    ? { continue: false, reason: 'limit' }
    : { continue: true }
}

export function createPlanRunContinuation(deps: {
  automaticCount(phiSessionId: string): number
  wakeConversation(phiSessionId: string, event: PlanRunFinishedEvent): void
  onLimit(phiSessionId: string, runId: string): void
}): (phiSessionId: string, event: PlanRunFinishedEvent) => void {
  const receipts = new Set<string>()
  return (phiSessionId, event) => {
    const receipt = `${phiSessionId}\0${event.runId}`
    if (receipts.has(receipt)) return
    receipts.add(receipt)
    while (receipts.size > 256) receipts.delete(receipts.values().next().value as string)
    const decision = shouldContinueAfterPlanRun(deps.automaticCount(phiSessionId))
    if (!decision.continue) {
      deps.onLimit(phiSessionId, event.runId)
      return
    }
    deps.wakeConversation(phiSessionId, event)
  }
}

const MAX_REPORT_LENGTH = 20000

function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`
}

function describe(event: AgentRunFinishedEvent): string {
  const lines = [
    `- ${event.agentRunId} · ${event.agent} · ${event.state} · took ${elapsed(event.elapsedSeconds)}`,
    `  task: ${event.task.replace(/\s+/g, ' ').trim()}`
  ]
  if (event.error) lines.push(`  ${event.error}`)
  if (event.report) {
    const report =
      event.report.length > MAX_REPORT_LENGTH
        ? `${event.report.slice(0, MAX_REPORT_LENGTH)}\n… (report truncated)`
        : event.report
    lines.push('  report:', report)
  }
  return lines.join('\n')
}

/** English, because the model reads this message (the user-facing notice is Chinese). */
export function agentRunContinuationPrompt(events: readonly AgentRunFinishedEvent[]): string {
  const anyFailed = events.some((event) => event.state === 'error')
  return [
    '<phi_agent_run_finished>',
    `This message is from Phi, not from the user. ${
      events.length === 1 ? 'A background agent run' : 'Background agent runs'
    } you started ${events.length === 1 ? 'has' : 'have'} ended:`,
    ...events.map(describe),
    'Continue with what the user asked for, using these results.',
    'If a completed report produced files, the closing reply must name the new or modified files with exact paths and purposes. A project directory or a delivery card alone is not enough; do not claim an output exists unless the report or a file check confirms it.',
    ...(anyFailed
      ? [
          'For a failed run, say why and propose the next step. Do not start it again unless the user asked for retries.'
        ]
      : []),
    'Reply in the language the user has been using.',
    '</phi_agent_run_finished>'
  ].join('\n')
}

const MAX_PLAN_CONTINUATION_LENGTH = 20000

function describePlanRun(state: PlanRunState): string[] {
  return [
    `Goal: ${state.spec.goal}`,
    ...state.spec.steps.map((step) => {
      const result = state.steps[step.id]
      const summary = result?.report?.text ?? result?.error
      return `- ${step.id} · ${step.title} · ${result?.status ?? 'unknown'}${
        summary ? `\n  ${summary.replace(/\s+/g, ' ').trim()}` : ''
      }`
    })
  ]
}

export function planRunContinuationPrompt(events: readonly PlanRunFinishedEvent[]): string {
  const header = [
    '<phi_plan_run_finished>',
    'This message is from Phi, not from the user. Approved plan execution has finished:'
  ].join('\n')
  const details = events.flatMap((event) => describePlanRun(event.state)).join('\n')
  const closing = [
    'Verify the reported results and any claimed files, then summarize the outcome for the user.',
    'Call out failed or skipped steps clearly. Do not silently rerun the plan.',
    'Reply in the language the user has been using.',
    '</phi_plan_run_finished>'
  ].join('\n')
  const text = `${header}\n${details}\n${closing}`
  if (text.length <= MAX_PLAN_CONTINUATION_LENGTH) return text
  const marker = '\n… (plan summary truncated)\n'
  const detailLimit =
    MAX_PLAN_CONTINUATION_LENGTH - header.length - closing.length - marker.length - 1
  return `${header}\n${details.slice(0, Math.max(0, detailLimit))}${marker}${closing}`
}

/** The one message a wake-up sends, whatever mix of background runs ended. */
export function continuationPrompt(events: readonly ContinuationEvent[]): string {
  const wrapperEvents = events.filter(
    (event): event is WrapperRunFinishedEvent => event.type === 'wrapper_run_finished'
  )
  const agentEvents = events.filter(
    (event): event is AgentRunFinishedEvent => event.type === 'agent_run_finished'
  )
  const planEvents = events.filter(
    (event): event is PlanRunFinishedEvent => event.type === 'plan_run_finished'
  )
  return [
    ...(wrapperEvents.length > 0 ? [wrapperRunContinuationPrompt(wrapperEvents)] : []),
    ...(agentEvents.length > 0 ? [agentRunContinuationPrompt(agentEvents)] : []),
    ...(planEvents.length > 0 ? [planRunContinuationPrompt(planEvents)] : [])
  ].join('\n\n')
}
