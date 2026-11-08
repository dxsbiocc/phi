import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionHost } from '../host'
import { planModeToolDecision, suppressPlanExecutePromptContext } from '../lib/plan-mode'

export function createPlanReviewToolGuardExtension(host: PhiExtensionHost): ExtensionFactory {
  return (pi) => {
    pi.on('context', (event) => {
      if (!host.planExecuteModeActive()) return undefined
      const messages = suppressPlanExecutePromptContext(event.messages)
      return messages ? { messages } : undefined
    })
    pi.on('tool_call', async (event) => {
      const structured = host.planExecuteModeActive()
      const decision = planModeToolDecision(
        host.planModeActive() || structured,
        event.toolName,
        event.input,
        structured
      )
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}
