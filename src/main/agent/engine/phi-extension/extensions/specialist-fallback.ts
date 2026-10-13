import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionAgentConfig, PhiExtensionHost } from '../host'
import { evaluateSpecialistFallback } from '../lib/fallback'

export function createSpecialistFallbackExtension(
  agents: readonly PhiExtensionAgentConfig[],
  host: PhiExtensionHost
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = evaluateSpecialistFallback(
        { toolName: event.toolName, input: event.input },
        agents,
        (agent, afterFailures) => host.fallbackReadiness(agent, afterFailures)
      )
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}
