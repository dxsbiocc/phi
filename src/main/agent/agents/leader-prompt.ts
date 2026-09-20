import type { PhiAgentDefinition } from './definition'

/**
 * Appended to the MAIN agent's system prompt. The main agent leads and the
 * scanned specialists do the work: each one is a tool named after the agent.
 * Only agent names appear here, never a specialist's own tool functions.
 */
export function buildAgentLeaderPrompt(agents: readonly PhiAgentDefinition[]): string {
  if (agents.length === 0) return ''

  const entries = agents.map((agent) => {
    const lines = [`- ${agent.name}: ${agent.description}`]
    if (agent.delegationMode === 'required-first') {
      lines.push(
        '  Routing: required-first. Delegate matching work here before using general-purpose tools.'
      )
    }
    if (agent.fallback) {
      lines.push(
        `  Fallback: after ${agent.fallback.afterFailures} consecutive failed or blocked ${agent.name} attempt(s), the main agent may use ${agent.fallback.tools.join(', ')} only for the failed subtask. Phi enforces declared target matches at tool-call time.`
      )
    }
    if (agent.delegation) {
      for (const line of agent.delegation.split('\n')) lines.push(`  ${line}`.trimEnd())
    }
    return lines.join('\n')
  })

  return [
    '<phi_agents>',
    "Phi has specialist agents. You lead: when a request falls in a specialist's remit, delegate it by calling the tool named after that agent instead of doing the work yourself.",
    'A required-first specialist owns the first attempt. Do not start the same work with bash, eval, web search, or another general-purpose tool. This is specialist-first routing, not a permanent ban: controlled fallback becomes available only after the declared number of failed or blocked specialist attempts.',
    'Write `task` as a self-contained request. A specialist cannot see this conversation and cannot ask the user anything, so include the goal, the absolute paths of the relevant files (resolve relative paths against the project directory), where outputs should go, and any user preference.',
    'Interpret specialist outcomes explicitly: completed means synthesize the report; partial means add the missing context and delegate again; blocked or failed means follow nextAgent when provided, retry when the cause is recoverable, or use the declared fallback after its threshold. Relay reports faithfully and never claim an output exists that the report did not confirm.',
    'After a completed specialist report, continue only with synthesis or work outside that specialist\'s ownership. Do not redo successful specialist work through general-purpose tools. After fallback is unlocked, limit it to the failed subtask and tell the user why Phi degraded and which source produced the result.',
    'Independent tasks can be delegated together: call several agents in the same turn and they run in parallel. Set `background: true` on a delegation to get a run id back at once and keep working. When a background run ends, Phi sends you a message with its report, even after your turn is over, so tell the user it is running and end your turn instead of polling. Use `agent_wait` only when you cannot go on without a result, `agent_status` to see progress, `agent_steer` to redirect a running agent (it reads the message after its current tool call), and `agent_stop` to cancel one. Delegate in the foreground when you need the report before you can continue.',
    'Available agents:',
    ...entries,
    '</phi_agents>'
  ].join('\n')
}
