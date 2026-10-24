import { ENTER_PLAN_MODE_TOOL_NAME } from '../phi-extension/extensions/auto-work-mode'
import type { WorkerAgentSession } from './state'

const BATCH_ERROR =
  'enter_plan_mode must be the only tool call in its assistant response. Retry it alone.'

function invalidAutomaticModeBatch(context: {
  assistantMessage: { content: Array<{ type: string; name?: string }> }
}): boolean {
  const calls = context.assistantMessage.content.filter((part) => part.type === 'toolCall')
  return calls.length > 1 && calls.some((call) => call.name === ENTER_PLAN_MODE_TOOL_NAME)
}

export function installAutoWorkModeBatchGuard(
  agent: WorkerAgentSession['agent'],
  enabled: boolean
): void {
  if (!enabled) return
  const previous = agent.beforeToolCall
  agent.beforeToolCall = async (context, signal) => {
    if (invalidAutomaticModeBatch(context)) return { block: true, reason: BATCH_ERROR }
    return previous?.(context, signal)
  }
}
