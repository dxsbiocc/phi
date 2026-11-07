import type { PhiAgentDefinition } from './definition'

/**
 * Appended to the MAIN agent's system prompt. The main agent leads and the
 * scanned specialists do the work: each one is a tool named after the agent.
 * Only agent names appear here, never a specialist's own tool functions.
 */
export function buildAgentLeaderPrompt(agents: readonly PhiAgentDefinition[]): string {
  const visibleAgents = agents.filter((agent) => agent.invocation !== 'host')
  if (visibleAgents.length === 0) return ''

  const entries = visibleAgents.map((agent) => {
    const lines = [`- ${agent.name}: ${agent.description}`]
    if (agent.delegationMode === 'required-first') {
      lines.push(
        '  Routing: required-first. Unless the user explicitly requested another route, when delegation is needed, delegate matching work here before using general-purpose tools.'
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
    'Routing order: (1) First decide whether the task needs an agent. Do small, direct work yourself: an answer, a quick read, one command, or a short edit. Delegate only when work is substantial or independent enough to hand off, or parallel work helps. (2) If it does, choose an existing specialist whose stated remit covers the task; otherwise use General. An explicit user request for a specific agent or for delegation overrides this automatic routing: honor it. Delegate only the requested subtask and keep it no broader than the user request. A straightforward literature search remains main-agent work; do not delegate it merely because a gene or database is mentioned.',
    'Unless the user explicitly requested another route, when delegation is needed, a required-first specialist owns the first attempt for work within its remit. Do not start the same work with bash, eval, web search, or another general-purpose tool. Once delegated, either wait for that run, stop/steer it, or work on a different non-overlapping subtask; never duplicate the same retrieval, download, plotting, or analysis while that specialist run is queued or running. Controlled fallback becomes available only after the declared number of failed or blocked specialist attempts.',
    'For public biological database lookups, use read on the public REST URL; for example, https://rest.uniprot.org/uniprotkb/P04637.json or https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gene&term=TP53&retmode=json.',
    'For explicit direct-file downloads, including database files, use download_file rather than shell, curl, or wget. Save files inside the current project.',
    'Write `task` as a self-contained request. A specialist cannot see this conversation and cannot ask the user anything, so include the goal, the absolute paths of the relevant files (resolve relative paths against the project directory), where outputs should go, and any user preference.',
    "Route by each specialist's stated remit, not by the tools it happens to have. If no specialist remit covers a delegable task, use General. Running ad-hoc shell commands, inspecting or counting files, and checking the project machine are General work unless the request concerns a specialist domain (for Wrapper: installed Nextflow wrappers and pipelines). Phi gives each General run its own Greek-letter name (for example Gamma), returned with the run id; use that name when you mention the run to the user.",
    'For a follow-up edit to an existing artifact, recover its exact source, input, and prior output paths from this conversation or the earlier specialist report, and include them in `task`. If those paths are unavailable, identify what is missing; do not turn a small revision into a new creation task.',
    'Interpret specialist outcomes explicitly: completed means synthesize the report; partial means add missing context and delegate again; not_found means valid specialist sources were searched without a matching record, so continue with a different source or declared fallback without repeating the same query; blocked means the source or capability is unavailable; failed means execution failed and may be retried only when recoverable. Follow nextAgent when provided. Relay reports faithfully and never claim an output exists that the report did not confirm.',
    'When specialists produce files, your final reply must name the new and modified user-facing files separately, give each exact path and purpose, and state the verified result. Do not replace this inventory with a project folder, a present_files card, or a claim that everything is archived. If a specialist report omits file names, request a concrete inventory from that specialist before declaring completion. Present the most important existing deliverables with present_files when available, then include their paths in the closing reply. Use render_blocks only for tabular results, QC metrics, or progress that would otherwise be a wall of text; otherwise use Markdown.',
    "After a completed specialist report, continue only with synthesis or work outside that specialist's ownership. Do not redo successful specialist work through general-purpose tools. After fallback is unlocked, limit it to the failed subtask and tell the user why Phi degraded and which source produced the result.",
    'Independent tasks, including several General tasks, can be delegated together: call several agents in the same turn and they run in parallel. Set `background: true` on a delegation to get a run id back at once and keep working. When a background run ends, Phi sends you a message with its report, even after your turn is over, so tell the user it is running and end your turn instead of polling. Use `agent_wait` only when you cannot go on without a result, `agent_status` to see progress, `agent_steer` to redirect a running agent (it reads the message after its current tool call), and `agent_stop` to cancel one. Delegate in the foreground when you need the report before you can continue.',
    'Available agents:',
    ...entries,
    '</phi_agents>'
  ].join('\n')
}
