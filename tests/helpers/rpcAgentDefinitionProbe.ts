import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { discoverAgents } from '@oh-my-pi/pi-coding-agent/task/discovery'

/** Actual CLI discovery/schema oracle. It never calls task or a model. */
export default function agentDefinitionProbe(pi: ExtensionAPI): void {
  pi.registerCommand('phi-agent-definition-probe', {
    description: 'Private test-only native agent discovery probe',
    handler: async (_args, ctx) => {
      const discovery = await discoverAgents(ctx.cwd, process.env.HOME)
      const task = pi.getAllTools().find((tool) => tool.name === 'task')
      if (!task) throw new Error('Actual native task tool is missing')
      const parameters = task.parameters as unknown as { toJsonSchema?: () => unknown }
      ctx.ui.notify(
        JSON.stringify({
          type: 'phi_agent_definition_probe',
          agents: discovery.agents.filter((agent) => agent.name.startsWith('phi_')),
          task: {
            description: task.description,
            parameters: parameters.toJsonSchema ? parameters.toJsonSchema() : parameters,
            source: task.sourceInfo.source
          }
        }),
        'info'
      )
    }
  })
}
