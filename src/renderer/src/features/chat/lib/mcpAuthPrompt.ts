import type {
  AgentUserInteractionResponse,
  McpAuthChoice,
  McpAuthPrompt
} from '../../../../../shared/agentInteractionTypes'
import { mcpAuthPromptCopy } from './mcpAuthPromptCopy'

export type { McpAuthChoice, McpAuthPrompt }

export type McpAuthPromptRequest = McpAuthPrompt & { requestId: string }

export type McpAuthErrorState =
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'api-missing' }
  | { kind: 'invalid-key' }
  | { kind: 'message'; message: string }

export type McpAuthPromptDraft = {
  requestId: string
  apiKey: string
  busy: boolean
  error: McpAuthErrorState | null
}

export type McpAuthPromptDraftAction =
  | { type: 'set-api-key'; apiKey: string }
  | { type: 'start-busy' }
  | { type: 'set-error'; error: McpAuthErrorState }

export function createMcpAuthPromptDraft(requestId: string): McpAuthPromptDraft {
  return { requestId, apiKey: '', busy: false, error: null }
}

export function mcpAuthPromptDraftForRequest(
  requestId: string,
  savedDraft: McpAuthPromptDraft | null
): McpAuthPromptDraft {
  return savedDraft?.requestId === requestId ? savedDraft : createMcpAuthPromptDraft(requestId)
}

export function reduceMcpAuthPromptDraft(
  draft: McpAuthPromptDraft,
  action: McpAuthPromptDraftAction
): McpAuthPromptDraft {
  switch (action.type) {
    case 'set-api-key':
      return { ...draft, apiKey: action.apiKey, error: null }
    case 'start-busy':
      return { ...draft, busy: true, error: null }
    case 'set-error':
      return { ...draft, busy: false, error: action.error }
  }
}

export function classifyMcpAuthError(cause: unknown): McpAuthErrorState {
  const raw =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'Unknown error'
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim()
  if (/Authorization timed out|授权已超时/i.test(cleaned)) return { kind: 'timeout' }
  if (/Authorization cancelled|授权已取消/i.test(cleaned)) return { kind: 'cancelled' }
  if (/No handler registered for/i.test(cleaned)) return { kind: 'api-missing' }
  if (/rejected|invalid api key|unauthorized|401|403/i.test(cleaned)) return { kind: 'invalid-key' }
  return { kind: 'message', message: cleaned || 'Authentication failed' }
}

export function formatMcpAuthError(error: McpAuthErrorState): string {
  switch (error.kind) {
    case 'timeout':
      return mcpAuthPromptCopy.errorTimeout
    case 'cancelled':
      return mcpAuthPromptCopy.errorCancelled
    case 'api-missing':
      return mcpAuthPromptCopy.errorApiMissing
    case 'invalid-key':
      return mcpAuthPromptCopy.errorInvalidKey
    case 'message':
      return error.message
  }
}

export function mcpAuthPromptResponse(
  requestId: string,
  connectorId: string,
  choice: McpAuthChoice
): AgentUserInteractionResponse {
  return {
    requestId,
    mcpAuthChoice: choice,
    ...(choice.action === 'cancel' ? { cancelled: true } : {}),
    answers: [
      {
        questionIndex: 0,
        question: `mcp_auth:${connectorId}`,
        kind: 'option',
        answer: choice.action
      }
    ]
  }
}
