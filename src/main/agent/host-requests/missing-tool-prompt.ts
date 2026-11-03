import type {
  AgentUserInteractionResponse,
  MissingToolChoice,
  MissingToolPrompt
} from '../../../shared/agentInteractionTypes'

export type ResolvedMissingToolChoice =
  { action: 'path'; path: string } | { action: 'install' } | { action: 'cancel' }

interface MissingToolPromptDependencies {
  request(params: unknown): Promise<unknown>
}

function fallbackOptions(input: MissingToolPrompt): Array<{
  label: string
  description: string
}> {
  return [
    { label: 'Enter a path', description: 'Choose an executable or environment folder.' },
    ...(input.install
      ? [
          {
            label: 'Install',
            description: `Create the Phi-managed ${input.install.environment} environment.`
          }
        ]
      : []),
    { label: 'Cancel', description: 'Stop this call without changing the host.' }
  ]
}

function normalizedChoice(response: unknown): ResolvedMissingToolChoice {
  const value = response as AgentUserInteractionResponse | null | undefined
  if (value?.cancelled) return { action: 'cancel' }
  const choice: MissingToolChoice | undefined = value?.missingToolChoice
  if (!choice || choice.action === 'cancel') return { action: 'cancel' }
  if (choice.action === 'install') return { action: 'install' }
  const path = choice.path.trim()
  return path ? { action: 'path', path } : { action: 'cancel' }
}

export function createMissingToolPrompt(
  dependencies: MissingToolPromptDependencies
): (input: MissingToolPrompt) => Promise<ResolvedMissingToolChoice> {
  return async (input) =>
    normalizedChoice(
      await dependencies.request({
        runtimeSessionId: input.runtimeSessionId,
        questions: [
          {
            header: 'Tool',
            question: `${input.tool.label} is required before this call can continue.`,
            options: fallbackOptions(input)
          }
        ],
        missingTool: input
      })
    )
}
