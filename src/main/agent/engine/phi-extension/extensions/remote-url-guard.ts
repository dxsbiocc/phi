import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { remoteUrlGuardDecision } from '../lib/remote-url'

export function createRemoteUrlGuardExtension(): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = remoteUrlGuardDecision(event.toolName, event.input)
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}
