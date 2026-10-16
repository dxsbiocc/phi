import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelOption, ProviderAuthStatus, ThinkingLevel } from './types'

const defaultSessionKey = (): string => ''

type PendingSelections = {
  sessionKey: string
  confirmedModel: ModelOption | null
  confirmedThinking: ThinkingLevel
  confirmedModelRequest: number
  confirmedThinkingRequest: number
  pending: number
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
}

export function modelOptionFromSelection(
  selection: { providerId: string; modelId: string } | null,
  available: ModelOption[]
): ModelOption | null {
  if (!selection) return null
  return (
    available.find(
      (item) => item.providerId === selection.providerId && item.modelId === selection.modelId
    ) ?? {
      ...selection,
      name: `${selection.providerId}/${selection.modelId}（不可用）`,
      thinkingLevels: []
    }
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
  showSnackbarError: (error: unknown, fallback: string) => void,
  getSessionKey: () => string = defaultSessionKey
): ModelSelectionState {
  const [models, setModels] = useState<ModelOption[]>([])
  const [isModelStateReady, setIsModelStateReady] = useState(false)
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('high')
  const modelRequestRef = useRef(0)
  const thinkingRequestRef = useRef(0)
  const selectionReadRef = useRef(0)
  const pendingSelectionsRef = useRef<PendingSelections | null>(null)

  useEffect(() => {
    const sessionKey = getSessionKey()
    const modelRequest = modelRequestRef.current
    const thinkingRequest = thinkingRequestRef.current
    let disposed = false
    void (async () => {
      setIsModelStateReady(false)
      try {
        const [available, selected, level] = await Promise.all([
          window.api.listModels(),
          window.api.getSelectedModel(),
          window.api.getThinkingLevel()
        ])
        if (disposed) return
        setModels(available)
        if (
          sessionKey === getSessionKey() &&
          modelRequest === modelRequestRef.current &&
          thinkingRequest === thinkingRequestRef.current
        ) {
          setSelectedModel(modelOptionFromSelection(selected, available))
          if (isThinkingLevel(level)) setThinkingLevel(level)
        }
      } catch {
        // 模型列表加载失败不阻塞聊天；发送时会给出明确错误
      } finally {
        if (!disposed) setIsModelStateReady(true)
      }
    })()
    return () => {
      disposed = true
    }
  }, [getSessionKey])

  const availableModels = useMemo(() => {
    const configuredIds = new Set(
      providerStatuses
        .filter((provider) => provider.configured)
        .map((provider) => provider.providerId)
    )
    return models.filter((model) => configuredIds.has(model.providerId))
  }, [models, providerStatuses])

  const beginSelection = useCallback(
    (sessionKey: string): PendingSelections => {
      const pending =
        pendingSelectionsRef.current?.sessionKey === sessionKey &&
        pendingSelectionsRef.current.pending > 0
          ? pendingSelectionsRef.current
          : {
              sessionKey,
              confirmedModel: selectedModel,
              confirmedThinking: thinkingLevel,
              confirmedModelRequest: 0,
              confirmedThinkingRequest: 0,
              pending: 0
            }
      pendingSelectionsRef.current = pending
      pending.pending += 1
      return pending
    },
    [selectedModel, thinkingLevel]
  )

  const finishSelection = useCallback(
    async (pending: PendingSelections): Promise<void> => {
      pending.pending -= 1
      if (pending.pending > 0 || pending.sessionKey !== getSessionKey()) return
      const request = ++selectionReadRef.current
      const modelRequest = modelRequestRef.current
      const thinkingRequest = thinkingRequestRef.current
      const [selected, level] = await Promise.allSettled([
        Promise.resolve().then(() => window.api.getSelectedModel()),
        Promise.resolve().then(() => window.api.getThinkingLevel())
      ])
      if (
        pending.sessionKey !== getSessionKey() ||
        request !== selectionReadRef.current ||
        modelRequest !== modelRequestRef.current ||
        thinkingRequest !== thinkingRequestRef.current
      ) {
        return
      }
      // A newer busy rejection can settle before the earlier accepted change.
      // Reconcile only after the whole group settles, including older successes.
      setSelectedModel(
        selected.status === 'fulfilled'
          ? modelOptionFromSelection(selected.value, models)
          : pending.confirmedModel
      )
      setThinkingLevel(
        level.status === 'fulfilled' && isThinkingLevel(level.value)
          ? level.value
          : pending.confirmedThinking
      )
    },
    [getSessionKey, models]
  )

  const onSelectModel = useCallback(
    async (model: ModelOption | null): Promise<void> => {
      const sessionKey = getSessionKey()
      const request = ++modelRequestRef.current
      const isCurrent = (): boolean =>
        sessionKey === getSessionKey() && request === modelRequestRef.current
      const pending = beginSelection(sessionKey)
      setSelectedModel(model)
      try {
        await window.api.selectModel(model?.providerId ?? null, model?.modelId ?? null)
        if (request > pending.confirmedModelRequest) {
          pending.confirmedModel = model
          pending.confirmedModelRequest = request
        }
      } catch (error) {
        if (!isCurrent()) return
        setSelectedModel(pending.confirmedModel)
        showSnackbarError(error, '切换模型失败')
      } finally {
        // A refresh failure does not turn an accepted switch into a failure.
        await finishSelection(pending)
      }
    },
    [beginSelection, finishSelection, getSessionKey, showSnackbarError]
  )

  const onSelectThinkingLevel = useCallback(
    async (level: ThinkingLevel): Promise<void> => {
      const sessionKey = getSessionKey()
      const request = ++thinkingRequestRef.current
      const isCurrent = (): boolean =>
        sessionKey === getSessionKey() && request === thinkingRequestRef.current
      const pending = beginSelection(sessionKey)
      setThinkingLevel(level)
      try {
        await window.api.selectThinkingLevel(level)
        if (request > pending.confirmedThinkingRequest) {
          pending.confirmedThinking = level
          pending.confirmedThinkingRequest = request
        }
      } catch (error) {
        if (!isCurrent()) return
        setThinkingLevel(pending.confirmedThinking)
        showSnackbarError(error, '切换思考等级失败')
      } finally {
        await finishSelection(pending)
      }
    },
    [beginSelection, finishSelection, getSessionKey, showSnackbarError]
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
