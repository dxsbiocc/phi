import type { AgentExecutionItem } from './agentExecutionTypes'

/**
 * What a delegation card lets the user do to the agent it shows: redirect it
 * while it works (steer) or cancel it (stop). Both address a run inside an agent
 * session, and both only make sense while the run is going.
 */

export interface AgentRunControlTarget {
  agentRunId: string
  agentSessionId: string
}

/** `lost`: the run turned out not to exist any more (see {@link isAgentRunGoneError}). */
export function agentRunControlTarget(
  item: AgentExecutionItem,
  options: { lost?: boolean } = {}
): AgentRunControlTarget | null {
  if (options.lost || item.status !== 'running') return null
  if (!item.agentRunId || !item.agentSessionId) return null
  return { agentRunId: item.agentRunId, agentSessionId: item.agentSessionId }
}

/**
 * The worker forgets a session's runs when it goes away (for example after Phi was
 * restarted), and a run that has ended cannot be steered. Those are not failures to
 * retry: the card should stop offering controls.
 */
export function isAgentRunGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /no longer running|Unknown run|already finished/i.test(message)
}

export function agentRunStatusText(
  item: AgentExecutionItem,
  options: { lost?: boolean } = {}
): string {
  if (item.status === 'running') {
    if (options.lost) return '已中断'
    return item.background ? '后台运行中' : '运行中'
  }
  if (item.cancelled) return '已取消'
  return item.status === 'error' ? '失败' : '完成'
}
