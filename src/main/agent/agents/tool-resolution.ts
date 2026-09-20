import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

/**
 * Splits an agent's declared tool names into what the SDK session needs:
 * every name (so a restricted session activates it) plus the actual tool
 * objects for the names that are Phi tool functions. Names Phi does not
 * provide are passed through as SDK built-ins; the SDK drops unknown ones.
 */
export function resolveAgentTools(
  declared: readonly string[],
  phiTools: ReadonlyMap<string, CustomTool>
): { toolNames: string[]; customTools: CustomTool[] } {
  const toolNames = [...new Set(declared)]
  const customTools = toolNames
    .map((name) => phiTools.get(name))
    .filter((tool): tool is CustomTool => tool !== undefined)
  return { toolNames, customTools }
}
