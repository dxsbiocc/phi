import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModelOption, ProviderAuthStatus, ThinkingLevel } from './types'

export function modelOptionFromSelection(
  selection: { providerId: string; modelId: string } | null,
  available: ModelOption[]
): ModelOption | null {
  if (!selection) return null
  return (
    available.find(
      (item) => item.providerId === selection.providerId && item.modelId === selection.modelId
    ) ?? null
  )
}

export type ModelSelectionState = {
  models: ModelOption[]
  availableModels: ModelOption[]
  isModelStateReady: boolean
  selectedModel: ModelOption | null
  setSelectedModel: (
    model: ModelOption | null | ((prev: ModelOption | null) => ModelOption | null)
  ) => void
  thinkingLevel: ThinkingLevel
  setThinkingLevel: (level: ThinkingLevel) => void
  onSelectModel: (model: ModelOption | null) => Promise<void>
  onSelectThinkingLevel: (level: ThinkingLevel) => Promise<void>
}

export function useModelSelection(
  providerStatuses: ProviderAuthStatus[],
  showSnackbarError: (error: unknown, fallback: string) => void
): ModelSelectionState {
  const [models, setModels] = useState<ModelOption[]>([])
  const [isModelStateReady, setIsModelStateReady] = useState(false)
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('high')

  useEffect(() => {
    void (async () => {
      setIsModelStateReady(false)
      try {
        const [available, selected, level] = await Promise.all([
          window.api.listModels(),
          window.api.getSelectedModel(),
          window.api.getThinkingLevel()
        ])
        setModels(available)
        setSelectedModel(modelOptionFromSelection(selected, available))
        setThinkingLevel(level)
      } catch {
        // 模型列表加载失败不阻塞聊天；发送时会给出明确错误
      } finally {
        setIsModelStateReady(true)
      }
    })()
  }, [])

  const availableModels = useMemo(() => {
    const configuredIds = new Set(
      providerStatuses
        .filter((provider) => provider.configured)
        .map((provider) => provider.providerId)
    )
    return models.filter((model) => configuredIds.has(model.providerId))
  }, [models, providerStatuses])

  const onSelectModel = useCallback(
    async (model: ModelOption | null): Promise<void> => {
      if (!model) {
        setSelectedModel(null)
        return
      }
      const previous = selectedModel
      setSelectedModel(model)
      try {
        await window.api.selectModel(model.providerId, model.modelId)
      } catch (error) {
        setSelectedModel(previous)
        showSnackbarError(error, '切换模型失败')
      }
    },
    [selectedModel, showSnackbarError]
  )

  const onSelectThinkingLevel = useCallback(
    async (level: ThinkingLevel): Promise<void> => {
      const previous = thinkingLevel
      setThinkingLevel(level)
      try {
        await window.api.selectThinkingLevel(level)
      } catch (error) {
        setThinkingLevel(previous)
        showSnackbarError(error, '切换思考等级失败')
      }
    },
    [thinkingLevel, showSnackbarError]
  )

  return {
    models,
    availableModels,
    isModelStateReady,
    selectedModel,
    setSelectedModel,
    thinkingLevel,
    setThinkingLevel,
    onSelectModel,
    onSelectThinkingLevel
  }
}
