import type { ModelSelection } from '../projects'
import type { ModelRuntime, RuntimeModel } from '../runtime/runtime-adapter'

export interface SessionCreationModelInput {
  modelRuntime: ModelRuntime
  modelSelection: ModelSelection | null
}

export interface SessionCreationModelResolution {
  modelRuntime: ModelRuntime
  modelSelection: ModelSelection | null
  resolvedModel: {
    model: RuntimeModel
    selection: ModelSelection
    migratedFrom?: ModelSelection
  } | null
  model: RuntimeModel | undefined
}

export interface SessionCreationModelDependencies {
  resolve(
    runtime: ModelRuntime,
    selection: ModelSelection
  ): SessionCreationModelResolution['resolvedModel']
}

function assertSessionCreationModelResolved(
  input: SessionCreationModelInput,
  resolvedModel: SessionCreationModelResolution['resolvedModel']
): void {
  if (input.modelSelection && !resolvedModel) {
    throw new Error(
      `模型不可用: ${input.modelSelection.providerId}/${input.modelSelection.modelId}`
    )
  }
}

export function resolveSessionCreationModel(
  input: SessionCreationModelInput,
  dependencies: SessionCreationModelDependencies
): SessionCreationModelResolution {
  const resolvedModel = input.modelSelection
    ? dependencies.resolve(input.modelRuntime, input.modelSelection)
    : null
  assertSessionCreationModelResolved(input, resolvedModel)
  return {
    modelRuntime: input.modelRuntime,
    modelSelection: input.modelSelection,
    resolvedModel,
    model: resolvedModel?.model
  }
}
