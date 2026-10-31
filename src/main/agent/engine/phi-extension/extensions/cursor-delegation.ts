import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

import { CURSOR_DELEGATION_INSTRUCTION } from '../lib/cursor-delegation-instruction'

/**
 * OMP answers Cursor's server-side Task with "not implemented", while the working `task` tool is
 * advertised over MCP. Models tend to pick the built-in one unless they are told otherwise.
 */
export function createCursorDelegationExtension(): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', (event, ctx) => {
      if (ctx.model?.api !== 'cursor-agent') return undefined
      if (event.systemPrompt.includes(CURSOR_DELEGATION_INSTRUCTION)) return undefined
      return { systemPrompt: [...event.systemPrompt, CURSOR_DELEGATION_INSTRUCTION] }
    })
  }
}
