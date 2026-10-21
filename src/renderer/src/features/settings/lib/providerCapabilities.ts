import type { ManagedProviderModel } from '../../../../../shared/modelAvailabilityTypes'
import type { ProviderAuthStatus } from '../../../types'
import { providerManagementUi as copy } from './providerManagementUi'

export function providerCapabilityLabel(provider: Pick<ProviderAuthStatus, 'modelKinds'>): string {
  return (provider.modelKinds ?? ['chat'])
    .map((kind) => (kind === 'decision' ? copy.decision : copy.chat))
    .join(' · ')
}

export function filterProviders(
  providers: ProviderAuthStatus[],
  query: string
): ProviderAuthStatus[] {
  const normalized = query.trim().toLocaleLowerCase()
  return providers.filter((provider) => {
    const kinds = provider.modelKinds ?? ['chat']
    const capabilities = kinds
      .map((kind) =>
        kind === 'decision' ? 'decision judgment JEV 决策 判断' : 'chat conversation 对话 聊天'
      )
      .join(' ')
    return `${provider.name} ${provider.providerId} ${capabilities}`
      .toLocaleLowerCase()
      .includes(normalized)
  })
}

export function filterProviderModels(
  models: ManagedProviderModel[],
  query: string
): ManagedProviderModel[] {
  const normalized = query.trim().toLocaleLowerCase()
  return models.filter((model) =>
    `${model.name} ${model.modelId} ${model.kind === 'decision' ? 'JEV decision 判断 决策' : 'chat 对话 聊天'}`
      .toLocaleLowerCase()
      .includes(normalized)
  )
}
