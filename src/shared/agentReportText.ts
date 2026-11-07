const COMPLETE_BLOCK = /<phi_agent_result>[\s\S]*?<\/phi_agent_result>/giu
// An unclosed block: a report still streaming, or one whose closing tag was dropped.
// Remove the tag and its JSON object only, so the prose after it stays visible.
const UNCLOSED_BLOCK = /<phi_agent_result>[^}]*(?:\}|$)/giu
const STRAY_CLOSE = /<\/phi_agent_result>/giu

/**
 * `<phi_agent_result>` is Phi's machine-readable report metadata for the main agent and
 * the plan engine. It is a model protocol, never text a person should read.
 */
export function stripAgentReportMetadata(text: string): string {
  return text
    .replace(COMPLETE_BLOCK, '')
    .replace(UNCLOSED_BLOCK, '')
    .replace(STRAY_CLOSE, '')
    .trim()
}
