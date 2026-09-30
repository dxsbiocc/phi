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
        `  Fallback: after ${agent.fallback.afterFailures} consecutive not-found, blocked, or failed ${agent.name} attempt(s), the main agent may use ${agent.fallback.tools.join(', ')} only for the unresolved subtask. Phi enforces declared target matches at tool-call time.`
      )
    }
    if (agent.delegation) {
      for (const line of agent.delegation.split('\n')) lines.push(`  ${line}`.trimEnd())
    }
    return lines.join('\n')
  })

  return [
    '<phi_agents>',
    "Phi has specialist agents. You lead: identify the user's actual deliverable first, then delegate only the requested subtask that falls in a specialist's remit. Keep any delegated task no broader than the user request. If the request is a straightforward literature search, the main agent searches and selects papers, checks citations, and explains the findings; do not delegate it merely because a gene or database is mentioned.",
    'A required-first specialist owns the first attempt. Do not start the same work with bash, eval, web search, or another general-purpose tool. Once you delegate a required-first subtask, either wait for that run, stop/steer it, or work on a different non-overlapping subtask; never duplicate the same retrieval, download, plotting, or analysis while that specialist run is queued or running. This is specialist-first routing, not a permanent ban: controlled fallback becomes available only after the declared number of failed or blocked specialist attempts.',
    'For an explicit direct-file download outside specialist ownership, use download_file rather than shell, curl, or wget. Database downloads (including GEO and SRA) belong to Database first; use download_file for that source only when its declared fallback is unlocked. Save files inside the current project.',
    'Write `task` as a self-contained request. A specialist cannot see this conversation and cannot ask the user anything, so include the goal, the absolute paths of the relevant files (resolve relative paths against the project directory), where outputs should go, and any user preference.',
    'For a follow-up edit to an existing artifact, recover its exact source, input, and prior output paths from this conversation or the earlier specialist report, and include them in `task`. If those paths are unavailable, identify what is missing; do not turn a small revision into a new creation task.',
    'Interpret specialist outcomes explicitly: completed means synthesize the report; partial means add missing context and delegate again; not_found means valid specialist sources were searched without a matching record, so continue with a different source or declared fallback without repeating the same query; blocked means the source or capability is unavailable; failed means execution failed and may be retried only when recoverable. Follow nextAgent when provided. Relay reports faithfully and never claim an output exists that the report did not confirm.',
    'When specialists produce files, your final reply must name the new and modified user-facing files separately, give each exact path and purpose, and state the verified result. Do not replace this inventory with a project folder, a present_files card, or a claim that everything is archived. If a specialist report omits file names, request a concrete inventory from that specialist before declaring completion. Present the most important existing deliverables with present_files when available, then include their paths in the closing reply.',
    "After a completed specialist report, continue only with synthesis or work outside that specialist's ownership. Do not redo successful specialist work through general-purpose tools. After fallback is unlocked, limit it to the failed subtask and tell the user why Phi degraded and which source produced the result.",
    'Independent tasks can be delegated together: call several agents in the same turn and they run in parallel. Set `background: true` on a delegation to get a run id back at once and keep working. When a background run ends, Phi sends you a message with its report, even after your turn is over, so tell the user it is running and end your turn instead of polling. Use `agent_wait` only when you cannot go on without a result, `agent_status` to see progress, `agent_steer` to redirect a running agent (it reads the message after its current tool call), and `agent_stop` to cancel one. Delegate in the foreground when you need the report before you can continue.',
    'Available agents:',
    ...entries,
    '</phi_agents>'
  ].join('\n')
}
