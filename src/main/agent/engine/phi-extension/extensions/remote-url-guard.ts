import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { protectedHomeWriteDecision } from '../lib/project-boundary'
import { remoteUrlGuardDecision } from '../lib/remote-url'

/**
 * Mounted for main sessions and specialists alike, with or without a project, so it also
 * carries the protected home check: shell commands never change shell profiles or credentials.
 */
export function createRemoteUrlGuardExtension(): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const home = protectedHomeWriteDecision(event.toolName, event.input)
      if (!home.allowed) return { block: true, reason: home.reason }
      const decision = remoteUrlGuardDecision(event.toolName, event.input)
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}
