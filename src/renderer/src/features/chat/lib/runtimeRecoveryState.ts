import type {
  RuntimeRecoveryModelSelection,
  RuntimeRecoveryTarget
} from '../../../../../shared/runtimeRecoveryTypes'

/** Runtime generation may advance because of this recovery; navigation changes the stable view identity. */
export function runtimeRecoveryViewKey(target: RuntimeRecoveryTarget | null): string {
  return target ? JSON.stringify([target.sessionId, target.projectId, target.sessionPath]) : ''
}
export function selectedRecoveryModel(
  value: string,
  available: readonly RuntimeRecoveryModelSelection[]
): RuntimeRecoveryModelSelection | undefined {
  const selected = available.find(
    (model) => JSON.stringify([model.providerId, model.modelId]) === value
  )
  return selected ? { providerId: selected.providerId, modelId: selected.modelId } : undefined
}
