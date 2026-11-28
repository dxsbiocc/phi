import type {
  AgentUserInteractionResponse,
  McpAuthChoice,
  McpAuthPrompt
} from '../../../shared/agentInteractionTypes'

interface McpAuthPromptDependencies {
  request(
    params: unknown,
    context?: { originSessionId?: string; signal?: AbortSignal }
  ): Promise<unknown>
}

function fallbackOptions(input: McpAuthPrompt): Array<{ label: string; description: string }> {
  return input.kind === 'oauth'
    ? [
        {
          label: 'Sign in',
          description: `Authorize ${input.connector.title} in your browser.`
        },
        { label: 'Skip for now', description: 'Continue without connecting this Connector.' }
      ]
    : [
        {
          label: 'Configure API key',
          description: `Verify and save an encrypted API key for ${input.connector.title}.`
        },
        { label: 'Skip for now', description: 'Continue without connecting this Connector.' }
      ]
}

function normalizedChoice(response: unknown): McpAuthChoice {
  const value = response as AgentUserInteractionResponse | null | undefined
  if (value?.cancelled) return { action: 'cancel' }
  if (value?.mcpAuthChoice?.action === 'authenticated') return { action: 'authenticated' }
  return { action: 'cancel' }
}

export function createMcpAuthPrompt(
  dependencies: McpAuthPromptDependencies
): (
  input: McpAuthPrompt,
  context?: { originSessionId?: string; signal?: AbortSignal }
) => Promise<McpAuthChoice> {
  return async (input, context) =>
    normalizedChoice(
      await dependencies.request(
        {
          runtimeSessionId: input.runtimeSessionId,
          questions: [
            {
              header: 'Connector',
              question:
                input.kind === 'oauth'
                  ? `Sign in to ${input.connector.title} before Phi connects its tools.`
                  : `Enter an API key for ${input.connector.title} before Phi connects its tools.`,
              options: fallbackOptions(input)
            }
          ],
          mcpAuth: input
        },
        context
      )
    )
}
