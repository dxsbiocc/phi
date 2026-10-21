export interface ModelRef {
  providerId: string
  modelId: string
}

export interface ModelAvailabilitySettings {
  disabledProviders: string[]
  disabledModels: ModelRef[]
}

export interface ManagedProviderModel extends ModelRef {
  name: string
  kind: 'chat' | 'decision'
  configured: boolean
  enabled: boolean
}

export interface ModelAvailabilitySnapshot extends ModelAvailabilitySettings {
  models: ManagedProviderModel[]
}

export interface ModelAvailabilityChange {
  providerId: string
  modelId?: string
  enabled: boolean
}
