import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { projectToolBoundaryDecision } from '../lib/project-boundary'

export function createProjectToolBoundaryExtension(cwd: string): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = projectToolBoundaryDecision(cwd, event.toolName, event.input)
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}
