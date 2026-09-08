import type { ModelOption, ProviderAuthStatus } from '../types'

export type PromptReadiness =
  | { ready: true }
  | { ready: false; reason: 'providers_loading' | 'no_configured_provider' | 'no_available_model' }

export function getPromptReadiness(input: {
  modelStateReady: boolean
  providers: ProviderAuthStatus[]
  availableModels: ModelOption[]
}): PromptReadiness {
  if (!input.modelStateReady) return { ready: false, reason: 'providers_loading' }
  if (!input.providers.some((provider) => provider.configured)) {
    return { ready: false, reason: 'no_configured_provider' }
  }
  if (input.availableModels.length === 0) {
    return { ready: false, reason: 'no_available_model' }
  }
  return { ready: true }
}
