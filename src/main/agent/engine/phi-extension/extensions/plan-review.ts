import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionHost } from '../host'
import { planModeToolDecision } from '../lib/plan-mode'

export function createPlanReviewToolGuardExtension(host: PhiExtensionHost): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = planModeToolDecision(host.planModeActive(), event.toolName, event.input)
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}
