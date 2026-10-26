function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

export function updateKernelSessionSelection(
  inputs: Map<string, Record<string, unknown>>,
  sessionId: string,
  patch: { model?: { provider: string; id: string }; thinkingLevel?: string }
): void {
  const input = inputs.get(sessionId)
  if (input && patch.model) input.model = { ...patch.model }
  if (input && patch.thinkingLevel) input.thinkingLevel = patch.thinkingLevel
}

export function kernelSessionSelectionFromState(value: unknown): {
  model?: { provider: string; id: string }
  thinkingLevel?: string
} {
  const result = record(value)
  const state = record(result?.state) ?? result
  const model = record(state?.model)
  const provider = nonEmptyString(model?.provider)
  const id = nonEmptyString(model?.id)
  const thinkingLevel = nonEmptyString(state?.thinkingLevel)
  const selection: {
    model?: { provider: string; id: string }
    thinkingLevel?: string
  } = {}
  if (provider && id) selection.model = { provider, id }
  if (thinkingLevel) selection.thinkingLevel = thinkingLevel
  return selection
}

export function kernelRunCompletionMetadata(
  inputs: ReadonlyMap<string, Record<string, unknown>>,
  sessionId: string
): {
  model?: { provider: string; id: string }
  resourceVersion?: string
} {
  const input = inputs.get(sessionId)
  const model = input?.model
  const resourceVersion = input?.resourceVersion
  return {
    ...(model && typeof model === 'object' && !Array.isArray(model)
      ? {
          model: {
            provider: String((model as { provider?: unknown }).provider),
            id: String((model as { id?: unknown }).id)
          }
        }
      : {}),
    ...(typeof resourceVersion === 'string' ? { resourceVersion } : {})
  }
}
