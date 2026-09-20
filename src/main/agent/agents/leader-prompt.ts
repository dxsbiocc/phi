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
    if (agent.delegation) {
      for (const line of agent.delegation.split('\n')) lines.push(`  ${line}`.trimEnd())
    }
    return lines.join('\n')
  })

  return [
    '<phi_agents>',
    "Phi has specialist agents. You lead: when a request falls in a specialist's remit, delegate it by calling the tool named after that agent instead of doing the work yourself.",
    'Write `task` as a self-contained request. A specialist cannot see this conversation and cannot ask the user anything, so include the goal, the absolute paths of the relevant files (resolve relative paths against the project directory), where outputs should go, and any user preference.',
    'If a report says something is missing, get it from the user (or infer it from the project), then delegate again with the fuller task. Relay reports faithfully, and never claim an output exists that the report did not confirm. Once a specialist has produced outputs you may continue with downstream work yourself.',
    'Available agents:',
    ...entries,
    '</phi_agents>'
  ].join('\n')
}
