import type {
  ModelAvailabilitySnapshot,
  ModelAvailabilitySettings,
  ManagedProviderModel
} from '../../shared/modelAvailabilityTypes'
import { getPhiEngine } from './engine/in-process-engine'
import type { PhiEngine } from './engine/types'
import { getPhiAgentDir } from './runtime-paths'
import {
  isModelEnabled,
  parseModelAvailabilityChange,
  readModelAvailability,
  writeModelAvailabilityChange
} from './model-availability'

type CatalogEngine = {
  models: Pick<PhiEngine['models'], 'snapshot'>
  decisions: Pick<PhiEngine['decisions'], 'models'>
}

async function loadCatalog(
  agentDir: string,
  engine: CatalogEngine
): Promise<{
  providerIds: Set<string>
  models: Omit<ManagedProviderModel, 'enabled'>[]
}> {
  // Use the raw engine catalog so disabled entries remain manageable and can be re-enabled.
  const [chat, decisions] = await Promise.all([
    engine.models.snapshot({ agentDir }),
    engine.decisions.models({ agentDir })
  ])
  const configured = new Set(
    chat.providers.filter((provider) => provider.status?.configured).map((provider) => provider.id)
  )
  for (const credential of chat.credentials) configured.add(credential.providerId)
  return {
    providerIds: new Set([
      ...chat.providers.map((provider) => provider.id),
      ...chat.models.map((model) => model.provider),
      ...decisions.map((model) => model.providerId)
    ]),
    models: [
      ...chat.models.map((model) => ({
        providerId: model.provider,
        modelId: model.id,
        name: model.name,
        kind: 'chat' as const,
        configured: configured.has(model.provider)
      })),
      ...decisions.map((model) => ({ ...model, kind: 'decision' as const }))
    ]
  }
}

function snapshot(
  catalog: Awaited<ReturnType<typeof loadCatalog>>,
  settings: ModelAvailabilitySettings
): ModelAvailabilitySnapshot {
  return {
    ...settings,
    models: catalog.models.map((model) => ({
      ...model,
      enabled: isModelEnabled(settings, model.providerId, model.modelId)
    }))
  }
}

export async function getModelAvailability(
  agentDir = getPhiAgentDir(),
  engine: CatalogEngine = getPhiEngine()
): Promise<ModelAvailabilitySnapshot> {
  const catalog = await loadCatalog(agentDir, engine)
  return snapshot(catalog, readModelAvailability(agentDir))
}

export async function setModelEnabled(
  value: unknown,
  agentDir = getPhiAgentDir(),
  engine: CatalogEngine = getPhiEngine()
): Promise<ModelAvailabilitySnapshot> {
  const change = parseModelAvailabilityChange(value)
  const catalog = await loadCatalog(agentDir, engine)
  if (
    !catalog.providerIds.has(change.providerId) ||
    (change.modelId !== undefined &&
      !catalog.models.some(
        (model) => model.providerId === change.providerId && model.modelId === change.modelId
      ))
  )
    throw new Error('Unknown provider or model')
  // No await between the fresh settings read and write; independent toggle replies cannot lose updates.
  return snapshot(catalog, writeModelAvailabilityChange(change, agentDir))
}
