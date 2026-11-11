import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { projectToolBoundaryDecision } from '../lib/project-boundary'

/** Asks the user about one call that reaches outside the project; null lets it run. */
export type OutsideProjectApproval = (
  event: { toolCallId: string; toolName: string; input: unknown },
  outsidePath: string
) => Promise<unknown>

export function createProjectToolBoundaryExtension(
  cwd: string,
  approveOutsideProject?: OutsideProjectApproval,
  agentDir?: string
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = projectToolBoundaryDecision(cwd, event.toolName, event.input, agentDir)
      if (decision.allowed) return undefined
      if (!decision.approvable || !approveOutsideProject)
        return { block: true, reason: decision.reason }
      const result = await approveOutsideProject(event, decision.outsidePath)
      if (result === null || result === undefined) return undefined
      return { block: true, reason: decision.reason }
    })
  }
}
