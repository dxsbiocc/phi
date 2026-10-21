import { MODEL_AVAILABILITY_CHANGED } from './lib/modelAvailabilityEvents'
import { useCallback, useEffect, useState } from 'react'
import type { ActiveAuthPrompt, AuthInteractionEvent, ProviderAuthStatus } from './types'
import { readableErrorMessage } from './lib/sessionNotifications'
import type { AuthEvent } from './lib/authTypes'
import { useUiLanguage } from './lib/i18n'
import { settingsUi } from './features/settings/lib/settingsUi'

function providerHintText(event: AuthEvent | null): string {
  if (!event) return ''
  switch (event.type) {
    case 'auth_url':
      return settingsUi.providerAuth.authorizationUrl(event.url)
    case 'device_code':
      return settingsUi.providerAuth.deviceCode(event.userCode)
    case 'info':
    case 'progress':
      return event.message
    default:
      return settingsUi.providerAuth.hintReceived
  }
}

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

export function useProviderAuth(
  setIsBusy: (busy: boolean) => void,
  notify: (message: string, severity: 'success' | 'error') => void
): ProviderAuthState {
  useUiLanguage()
  const [providerStatuses, setProviderStatuses] = useState<ProviderAuthStatus[]>([])
  const [activePrompts, setActivePrompts] = useState<ActiveAuthPrompt[]>([])
  const [providerHintEvents, setProviderHintEvents] = useState<Record<string, AuthEvent | null>>({})
  const [isProviderDialogOpen, setIsProviderDialogOpen] = useState(false)
  const [providerDialogProviderId, setProviderDialogProviderId] = useState<string | null>(null)

  const refreshAuthStatuses = useCallback(async (): Promise<void> => {
    const data = await window.api.getAuthStatus()
    setProviderStatuses(data)
    window.dispatchEvent(new Event(MODEL_AVAILABILITY_CHANGED))
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
        window.dispatchEvent(new Event(MODEL_AVAILABILITY_CHANGED))
        setProviderHintEvents((prev) => ({ ...prev, [providerId]: null }))
        setIsProviderDialogOpen(false)
        notify(settingsUi.providerAuth.apiKeySaved, 'success')
      } catch (error) {
        notify(
          settingsUi.providerAuth.apiKeySaveFailed(
            readableErrorMessage(error, settingsUi.providerAuth.retry)
          ),
          'error'
        )
      } finally {
        setIsBusy(false)
      }
    },
    [notify, setIsBusy]
  )

  const submitProviderOAuth = useCallback(
    async (providerId: string): Promise<void> => {
      setIsBusy(true)
      try {
        const next = await window.api.loginOAuth(providerId)
        setProviderStatuses(next)
        window.dispatchEvent(new Event(MODEL_AVAILABILITY_CHANGED))
        setProviderHintEvents((prev) => ({ ...prev, [providerId]: null }))
        setActivePrompts((prev) => prev.filter((item) => item.providerId !== providerId))
        setIsProviderDialogOpen(false)
        notify(settingsUi.providerAuth.loginSucceeded, 'success')
      } catch (error) {
        setProviderHintEvents((prev) => ({ ...prev, [providerId]: null }))
        notify(
          settingsUi.providerAuth.loginFailed(
            readableErrorMessage(error, settingsUi.providerAuth.retry)
          ),
          'error'
        )
      } finally {
        setIsBusy(false)
      }
    },
    [notify, setIsBusy]
  )

  const logoutProvider = useCallback(
    async (providerId: string): Promise<void> => {
      try {
        await window.api.logout(providerId)
        await refreshAuthStatuses()
        setProviderHintEvents((prev) => ({ ...prev, [providerId]: null }))
        notify(settingsUi.providerAuth.loggedOut, 'success')
      } catch (error) {
        notify(
          settingsUi.providerAuth.logoutFailed(
            readableErrorMessage(error, settingsUi.providerAuth.retry)
          ),
          'error'
        )
      }
    },
    [notify, refreshAuthStatuses]
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

    setProviderHintEvents((prev) => ({
      ...prev,
      [event.providerId]: event.event
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
    providerHints: Object.fromEntries(
      Object.entries(providerHintEvents).map(([id, event]) => [id, providerHintText(event)])
    ),
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
