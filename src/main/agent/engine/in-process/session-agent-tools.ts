import type { PhiAgentDefinition } from '../../agents/definition'
import { AgentRunRegistry, type AgentRunFn } from '../../agents/registry'
import { buildAgentRunTools } from '../../agents/run-tools'
import { buildAgentTool, type AgentToolOptions } from '../../agents/tool'
import type { PhiTool } from '../types'

export function supportsDelegationTool(definition: PhiAgentDefinition): boolean {
  return definition.invocation !== 'host'
}

export function buildSessionAgentDelegationTools(options: {
  definitions: readonly PhiAgentDefinition[]
  runnerFor: (definition: PhiAgentDefinition) => AgentRunFn
  registry: AgentRunRegistry
  toolOptions: AgentToolOptions
  includeRunTools?: boolean
}): PhiTool[] {
  const definitions = options.definitions.filter(supportsDelegationTool)
  if (definitions.length === 0) return []
  const tools = definitions.map((definition) =>
    buildAgentTool(definition, options.runnerFor(definition), options.registry, options.toolOptions)
  )
  return options.includeRunTools === false
    ? tools
    : [...tools, ...buildAgentRunTools(options.registry)]
}
