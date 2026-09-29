import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

export const VISUALIZATION_WORKFLOWS = ['examples', 'create', 'revise', 'reference'] as const
export type VisualizationWorkflow = (typeof VISUALIZATION_WORKFLOWS)[number]

/** Keep creation tools out of an existing-figure revision's model context. */
export function visualizationToolNamesForWorkflow(
  declared: readonly string[],
  workflow: VisualizationWorkflow | undefined
): string[] {
  if (!workflow) return [...declared]
  const allowed =
    workflow === 'examples'
      ? new Set(['viz_examples'])
      : workflow === 'revise'
        ? new Set(['viz_render'])
        : new Set(['viz_route', 'viz_prepare', 'viz_render'])
  return declared.filter((name) => !name.startsWith('viz_') || allowed.has(name))
}

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

export function buildScopedPhiToolMap(
  agentName: string,
  groups: {
    wrapper: readonly CustomTool[]
    database: readonly CustomTool[]
    visualization?: readonly CustomTool[]
  }
): Map<string, CustomTool> {
  const tools =
    agentName === 'Wrapper'
      ? groups.wrapper
      : agentName === 'Database'
        ? groups.database
        : agentName === 'Visualization'
          ? (groups.visualization ?? [])
          : []
  return new Map(tools.map((tool) => [tool.name, tool]))
}
