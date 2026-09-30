export interface WebSearchProviderOption {
  id: string
  label: string
  description: string
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
