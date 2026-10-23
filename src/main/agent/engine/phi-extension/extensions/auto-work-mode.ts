import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@oh-my-pi/pi-coding-agent'

import type { PhiExtensionHost } from '../host'

export const ENTER_PLAN_MODE_TOOL_NAME = 'enter_plan_mode'

const parameters = {
  type: 'object',
  additionalProperties: false,
  required: ['execute', 'reason'],
  properties: {
    execute: { type: 'boolean' },
    reason: { type: 'string', minLength: 1, maxLength: 200 }
  }
} as ToolDefinition['parameters']

function planModeResult(execute: boolean): string {
  return execute
    ? 'Planning and execution mode is now active. Use only read-only investigation, then submit the complete structured plan through propose_plan_steps for user review.'
    : 'Plan review mode is now active. Use only read-only investigation, then write the plan under local:// and submit it through xd://propose for user review.'
}

function registerExclusiveCallGate(pi: ExtensionAPI): () => boolean {
  let allowed = false
  pi.on('assistant_message', (event) => {
    const toolCalls = event.message.content.filter((part) => part.type === 'toolCall')
    allowed = toolCalls.length === 1 && toolCalls[0]?.name === ENTER_PLAN_MODE_TOOL_NAME
  })
  pi.on('turn_end', () => {
    allowed = false
  })
  return () => {
    const current = allowed
    allowed = false
    return current
  }
}

export function createAutoWorkModeExtension(host: PhiExtensionHost): ExtensionFactory {
  return (pi) => {
    const consumeExclusiveCall = registerExclusiveCallGate(pi)
    const definition: ToolDefinition & { concurrency: 'exclusive' } = {
      name: ENTER_PLAN_MODE_TOOL_NAME,
      label: 'Enter plan mode',
      description:
        'Switch this automatic-mode turn into planning. Call this tool alone. Use execute=false for plan review when the request is unclear, broad, or risky. Use execute=true when the work has multiple relatively independent tasks. Every plan still requires user review.',
      parameters,
      loadMode: 'essential',
      approval: 'read',
      strict: true,
      concurrency: 'exclusive',
      execute: async (_toolCallId, input) => {
        if (!consumeExclusiveCall()) {
          return {
            content: [
              {
                type: 'text',
                text: 'enter_plan_mode must be the only tool call in its assistant response. Retry it alone.'
              }
            ],
            isError: true
          }
        }
        if (!host.enterAutoPlanMode || host.planModeActive()) {
          return {
            content: [{ type: 'text', text: 'Automatic work mode is not active.' }],
            isError: true
          }
        }
        const value = input as { execute?: unknown; reason?: unknown }
        const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
        if (typeof value.execute !== 'boolean' || !reason || Array.from(reason).length > 200) {
          return {
            content: [{ type: 'text', text: 'Reason must contain 1 to 200 characters.' }],
            isError: true
          }
        }
        await host.enterAutoPlanMode({ execute: value.execute, reason })
        return { content: [{ type: 'text', text: planModeResult(value.execute) }] }
      }
    }
    pi.registerTool(definition)
  }
}
