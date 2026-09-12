import { useCallback, useEffect, useState } from 'react'
import type { ActiveAuthPrompt, AuthInteractionEvent, ProviderAuthStatus } from './types'

export type ProviderAuthState = {
  providerStatuses: ProviderAuthStatus[]
  activePrompts: ActiveAuthPrompt[]
  providerHints: Record<string, string>
  isProviderDialogOpen: boolean
  providerDialogProviderId: string | null
  refreshAuthStatuses: () => Promise<void>
  openProviderDialog: (providerId?: string | null) => void
  closeProviderDialog: () => void
  setProviderDialogProviderId: (providerId: string | null) => void
  submitProviderApiKey: (providerId: string, key: string) => Promise<void>
  submitProviderOAuth: (providerId: string) => Promise<void>
  logoutProvider: (providerId: string) => Promise<void>
  onSubmitAuthPrompt: (requestId: string, value: string) => Promise<void>
  onUpdatePromptValue: (requestId: string, value: string) => void
  /**
   * Feeds a raw `onAuthInteraction` IPC event into provider state. Returns true when the
   * caller should also surface the Settings dialog (a cross-domain concern this hook
   * doesn't own).
   */
  handleAuthInteractionEvent: (event: AuthInteractionEvent) => boolean
}

export function useProviderAuth(setIsBusy: (busy: boolean) => void): ProviderAuthState {
  const [providerStatuses, setProviderStatuses] = useState<ProviderAuthStatus[]>([])
  const [activePrompts, setActivePrompts] = useState<ActiveAuthPrompt[]>([])
  const [providerHints, setProviderHints] = useState<Record<string, string>>({})
  const [isProviderDialogOpen, setIsProviderDialogOpen] = useState(false)
  const [providerDialogProviderId, setProviderDialogProviderId] = useState<string | null>(null)

  const refreshAuthStatuses = useCallback(async (): Promise<void> => {
    const data = await window.api.getAuthStatus()
    setProviderStatuses(data)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshAuthStatuses()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshAuthStatuses])

  const openProviderDialog = useCallback((providerId: string | null = null): void => {
    setProviderDialogProviderId(providerId)
    setIsProviderDialogOpen(true)
  }, [])

  const closeProviderDialog = useCallback((): void => {
    setIsProviderDialogOpen(false)
    setProviderDialogProviderId(null)
    setActivePrompts([])
  }, [])

  const submitProviderApiKey = useCallback(
    async (providerId: string, key: string): Promise<void> => {
      if (!key.trim()) {
        return
      }
      setIsBusy(true)
      try {
        const next = await window.api.loginApiKey(providerId, key)
        setProviderStatuses(next)
        setProviderHints((prev) => ({
          ...prev,
          [providerId]: 'API Key 已提交（实际校验延后到发送消息时）'
        }))
      } finally {
        setIsBusy(false)
      }
    },
    [setIsBusy]
  )

  const submitProviderOAuth = useCallback(
    async (providerId: string): Promise<void> => {
      setIsBusy(true)
      try {
        const next = await window.api.loginOAuth(providerId)
        setProviderStatuses(next)
        setProviderHints((prev) => ({
          ...prev,
          [providerId]: 'OAuth 已触发，授权状态会在对话中完成'
        }))
      } finally {
        setIsBusy(false)
      }
    },
    [setIsBusy]
  )

  const logoutProvider = useCallback(
    async (providerId: string): Promise<void> => {
      await window.api.logout(providerId)
      await refreshAuthStatuses()
    },
    [refreshAuthStatuses]
  )

  const onSubmitAuthPrompt = useCallback(
    async (requestId: string, value: string): Promise<void> => {
      if (!value.trim()) {
        return
      }
      setIsBusy(true)
      try {
        await window.api.submitAuthInteraction(requestId, value)
        setActivePrompts((prev) => prev.filter((item) => item.requestId !== requestId))
      } finally {
        setIsBusy(false)
      }
    },
    [setIsBusy]
  )

  const onUpdatePromptValue = useCallback((requestId: string, value: string): void => {
    setActivePrompts((prev) =>
      prev.map((prompt) => (prompt.requestId === requestId ? { ...prompt, value } : prompt))
    )
  }, [])

  const handleAuthInteractionEvent = useCallback((event: AuthInteractionEvent): boolean => {
    if (event.type === 'prompt') {
      setActivePrompts((prev) => {
        const exists = prev.some((item) => item.requestId === event.requestId)
        if (exists) {
          return prev.map((item) =>
            item.requestId === event.requestId
              ? {
                  ...item,
                  prompt: event.prompt,
                  value: item.value
                }
              : item
          )
        }

        return [
          ...prev,
          {
            requestId: event.requestId,
            providerId: event.providerId,
            prompt: event.prompt,
            value: ''
          }
        ]
      })

      setProviderDialogProviderId(event.providerId)
      setIsProviderDialogOpen(true)
      return true
    }

    const hint =
      event.event.type === 'auth_url'
        ? `授权链接：${event.event.url}`
        : event.event.type === 'info'
          ? event.event.message
          : event.event.type === 'progress'
            ? event.event.message
            : event.event.type === 'device_code'
              ? `验证码：${event.event.userCode}`
              : '收到授权提示'

    setProviderHints((prev) => ({
      ...prev,
      [event.providerId]: hint
    }))

    setProviderDialogProviderId(event.providerId)
    if (
      event.event.type === 'progress' ||
      event.event.type === 'auth_url' ||
      event.event.type === 'device_code'
    ) {
      setIsProviderDialogOpen(true)
    }
    return false
  }, [])

  return {
    providerStatuses,
    activePrompts,
    providerHints,
    isProviderDialogOpen,
    providerDialogProviderId,
    refreshAuthStatuses,
    openProviderDialog,
    closeProviderDialog,
    setProviderDialogProviderId,
    submitProviderApiKey,
    submitProviderOAuth,
    logoutProvider,
    onSubmitAuthPrompt,
    onUpdatePromptValue,
    handleAuthInteractionEvent
  }
}
