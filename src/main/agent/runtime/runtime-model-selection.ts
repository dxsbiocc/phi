import type { ModelSelection } from '../projects'
import type { ModelRuntime, RuntimeModel } from './runtime-adapter'

const KIMI_CODE_REPLACEMENT_MODEL_IDS = [
  'kimi-for-coding',
  'k3',
  'k3-256k',
  'kimi-for-coding-highspeed'
] as const

function isRetiredKimiCodeModel(providerId: string, modelId: string): boolean {
  return providerId === 'kimi-code' && /^kimi-k2(?:$|[.-])/.test(modelId)
}

export function isSelectableRuntimeModel(model: { provider: string; id: string }): boolean {
  return !isRetiredKimiCodeModel(model.provider, model.id)
}

export function selectableRuntimeModels(runtime: ModelRuntime): RuntimeModel[] {
  return runtime.getModels().filter(isSelectableRuntimeModel)
}

export function resolveRuntimeModelSelection(
  runtime: ModelRuntime,
  selection: ModelSelection
): { model: RuntimeModel; selection: ModelSelection; migratedFrom?: ModelSelection } | null {
  const exact = runtime.getModel(selection.providerId, selection.modelId)
  if (exact && isSelectableRuntimeModel(exact)) {
    return { model: exact, selection }
  }

  if (!isRetiredKimiCodeModel(selection.providerId, selection.modelId)) {
    return null
  }

  for (const modelId of KIMI_CODE_REPLACEMENT_MODEL_IDS) {
    const replacement = runtime.getModel(selection.providerId, modelId)
    if (replacement && isSelectableRuntimeModel(replacement)) {
      return {
        model: replacement,
        selection: { providerId: replacement.provider, modelId: replacement.id },
        migratedFrom: selection
      }
    }
  }

  return null
}
