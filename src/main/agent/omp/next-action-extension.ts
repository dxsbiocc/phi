import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { NEXT_ACTION_RECOMMENDATION_INSTRUCTION } from '../../../shared/nextActionInstruction'

/** Add optional guidance to the provider-facing system prompt for this turn only. */
export function createNextActionInstructionExtension(
  isEnabled: () => Promise<boolean>
): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', async (event) => {
      try {
        if (!(await isEnabled())) return undefined
        if (event.systemPrompt.some((part) => part.includes('<phi_next_action_instruction>'))) {
          return undefined
        }
        return { systemPrompt: [...event.systemPrompt, NEXT_ACTION_RECOMMENDATION_INSTRUCTION] }
      } catch {
        // Optional presentation guidance must not block the user's prompt.
        return undefined
      }
    })
  }
}
