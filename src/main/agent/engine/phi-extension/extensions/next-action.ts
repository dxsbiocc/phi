import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionHost } from '../host'
import { NEXT_ACTION_RECOMMENDATION_INSTRUCTION } from '../lib/next-action-instruction'

export function createNextActionInstructionExtension(
  source: PhiExtensionHost | (() => Promise<boolean>)
): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', async (event) => {
      try {
        const enabled =
          typeof source === 'function'
            ? await source()
            : await source.nextActionSuggestionsEnabled()
        if (!enabled) return undefined
        if (event.systemPrompt.some((part) => part.includes('<phi_next_action_instruction>'))) {
          return undefined
        }
        return { systemPrompt: [...event.systemPrompt, NEXT_ACTION_RECOMMENDATION_INSTRUCTION] }
      } catch {
        return undefined
      }
    })
  }
}
