import {
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  createRuntimeAgentSession
} from '../runtime/runtime-adapter'

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

  if ('args' in event) {
    summary.args = event.args
  }

  if ('partialResult' in event) {
    summary.partialResult = event.partialResult
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

  if ('reason' in event) {
    summary.reason = event.reason
  }

  if ('action' in event) {
    summary.action = event.action
  }

  if ('aborted' in event) {
    summary.aborted = event.aborted
  }

  if ('willRetry' in event) {
    summary.willRetry = event.willRetry
  }

  if ('skipped' in event) {
    summary.skipped = event.skipped
  }

  if ('errorMessage' in event) {
    summary.errorMessage = event.errorMessage
  }

  return summary
}

export async function createAgentSession(
  options?: CreateAgentSessionOptions,
  onEvent?: (summary: AgentEventSummary) => void
): Promise<CreateAgentSessionResult> {
  const result = await createRuntimeAgentSession(options)

  result.session.subscribe((event) => {
    const summary = summarizeEvent(event)
    onEvent?.(summary)
  })

  return result
}
