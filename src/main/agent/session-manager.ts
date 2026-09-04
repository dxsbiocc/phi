import { createAgentSession as createSdkAgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent'

export type AgentEventSummary = Record<string, unknown>

function summarizeEvent(event: AgentSessionEvent): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    type: event.type
  }

  if ('messages' in event) {
    summary.messages = event.messages
    return summary
  }

  if ('message' in event) {
    summary.message = event.message
  }

  if ('toolCallId' in event) {
    summary.toolCallId = event.toolCallId
  }

  if ('toolName' in event) {
    summary.toolName = event.toolName
  }

  if ('assistantMessageEvent' in event) {
    summary.assistantMessageEvent = event.assistantMessageEvent
  }

  if ('toolResults' in event) {
    summary.toolResults = event.toolResults
  }

  if ('result' in event) {
    summary.result = event.result
  }

  if ('isError' in event) {
    summary.isError = event.isError
  }

  return summary
}

export async function createAgentSession(
  options?: Parameters<typeof createSdkAgentSession>[0],
  onEvent?: (summary: AgentEventSummary) => void,
) {
  const result = await createSdkAgentSession(options)

  result.session.subscribe((event) => {
    const summary = summarizeEvent(event)
    onEvent?.(summary)
  })

  return result
}
