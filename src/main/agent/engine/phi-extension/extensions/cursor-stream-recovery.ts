import type { CreateAgentSessionResult, ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

const CURSOR_INCOMPLETE_STREAM = 'Cursor stream ended before turnEnded'

export type CursorRecoveryAgent = Pick<
  CreateAgentSessionResult['session']['agent'],
  'transformAssistantMessage'
>

export function createCursorStreamRecoveryExtension(
  getAgent: () => CursorRecoveryAgent | undefined = () => undefined
): ExtensionFactory {
  return (pi) => {
    let attempted = false
    let installedAgent: CursorRecoveryAgent | undefined
    pi.on('before_agent_start', () => {
      attempted = false
      const agent = getAgent()
      if (!agent || installedAgent === agent) return
      installedAgent = agent
      const previous = agent.transformAssistantMessage
      agent.transformAssistantMessage = async (message, signal) => {
        await previous?.call(agent, message, signal)
        if (
          attempted ||
          signal?.aborted ||
          message.api !== 'cursor-agent' ||
          message.stopReason !== 'error' ||
          message.errorMessage?.trim() !== CURSOR_INCOMPLETE_STREAM ||
          !message.content.some((block) => block.type === 'toolCall')
        )
          return
        // The SDK already resumes interrupted tool turns only after every call is paired.
        // Normalize this equivalent provider error so that path can preserve completed work.
        attempted = true
        message.errorMessage = `stream closed before a terminal response event: ${CURSOR_INCOMPLETE_STREAM}`
      }
    })
    pi.on('session_stop', (event) => {
      const message = event.last_assistant_message
      if (
        attempted ||
        event.stop_hook_active ||
        event.signal.aborted ||
        message?.role !== 'assistant' ||
        message.api !== 'cursor-agent' ||
        message.stopReason !== 'error' ||
        message.errorMessage?.trim() !== CURSOR_INCOMPLETE_STREAM ||
        message.content.some((block) => block.type === 'toolCall')
      )
        return undefined

      // Text-only partials retain their history and use the native hidden continuation.
      attempted = true
      return {
        continue: true,
        additionalContext:
          'The previous response was interrupted by the provider connection. Resume from the ' +
          'retained conversation and completed tool results; do not repeat completed work or ' +
          'side effects. Finish only the remaining response. If the task is already complete, ' +
          'confirm completion briefly.'
      }
    })
  }
}
