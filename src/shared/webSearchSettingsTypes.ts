export interface WebSearchProviderOption {
  id: string
  label: string
  description: string
  access: 'free' | 'metered' | 'self-hosted'
  auth: 'none' | 'optional' | 'api-key' | 'oauth-or-key' | 'oauth' | 'endpoint'
  apiKeyEnv?: string
  apiKeyConfigured?: boolean
  apiKeyStored?: boolean
  oauthConfigured?: boolean
}

export interface WebSearchKeyStatus {
  apiKeyConfigured: boolean
  apiKeyStored: boolean
}

export interface WebSearchSettings {
  providers: WebSearchProviderOption[]
  orderedEnabledIds: string[]
  searxngEndpoint: string
  searxngEngines: string
}

export interface WebSearchSettingsPatch {
  orderedEnabledIds: string[]
  searxngEndpoint: string
  searxngEngines: string
}

export interface SearxngEngineOption {
  name: string
  shortcut?: string
  categories: string[]
  enabled: boolean
}
