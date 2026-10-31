/** Provider-facing guidance; it must never be concatenated into a user message. */
export const CURSOR_DELEGATION_INSTRUCTION = [
  '<phi_cursor_delegation_instruction>',
  "Cursor's built-in Task and subagent tools are not available in this client and always fail.",
  'To delegate work to a subagent, call the `task` tool provided by the pi-agent MCP server.',
  'Never call the built-in Task tool. Only if pi-agent offers no `task` tool, do the work yourself.',
  '</phi_cursor_delegation_instruction>'
].join('\n')
