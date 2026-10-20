import { useEffect } from 'react'

import { getAppShortcutAction } from '../appShortcuts'
import type { RendererApi } from '../../types'

/**
 * App-level commands: keyboard shortcuts and the native menu-bar queue.
 *
 * Both are the same subject — a command that arrives from outside the window
 * ("new chat", "settings", "close dialogs") and must be applied to whatever the
 * shell currently shows. Keeping them together makes the two entry points easy
 * to compare, which matters because they deliberately overlap.
 */
export type AppCommandDeps = {
  rendererApi: Pick<RendererApi, 'consumeMenuBarAction'>
  activeView: string
  isSettingsOpen: boolean
  isProviderDialogOpen: boolean
  isNewProjectDialogOpen: boolean
  closeProviderDialog: () => void
  setIsSettingsOpen: (open: boolean) => void
  setIsNewProjectDialogOpen: (open: boolean) => void
  navigateToView: (view: 'chat') => void
  onNewChat: () => Promise<void> | void
  openSettings: () => void
}

type ShortcutContext = Pick<
  AppCommandDeps,
  | 'activeView'
  | 'isSettingsOpen'
  | 'isProviderDialogOpen'
  | 'isNewProjectDialogOpen'
  | 'closeProviderDialog'
  | 'setIsSettingsOpen'
  | 'setIsNewProjectDialogOpen'
  | 'navigateToView'
  | 'onNewChat'
>

function focusPrimaryInput(activeView: string): void {
  const selector = activeView === 'chat' ? '[data-phi-focus="chat-input"]' : 'input[type="text"]'
  const target = document.querySelector<HTMLElement>(selector)
  target?.focus({ preventScroll: true })
}

export function applyShortcut(event: KeyboardEvent, context: ShortcutContext): void {
  const action = getAppShortcutAction(event)
  if (!action) return

  if (action === 'new-chat') {
    event.preventDefault()
    context.navigateToView('chat')
    void context.onNewChat()
    return
  }

  if (action === 'focus-primary-input') {
    event.preventDefault()
    focusPrimaryInput(context.activeView)
    return
  }

  if (action === 'close-dialogs') {
    if (context.isSettingsOpen || context.isProviderDialogOpen || context.isNewProjectDialogOpen) {
      event.preventDefault()
      context.setIsSettingsOpen(false)
      context.closeProviderDialog()
      context.setIsNewProjectDialogOpen(false)
    }
  }
}

export function useAppCommands(deps: AppCommandDeps): void {
  const {
    rendererApi,
    activeView,
    isSettingsOpen,
    isProviderDialogOpen,
    isNewProjectDialogOpen,
    closeProviderDialog,
    setIsSettingsOpen,
    setIsNewProjectDialogOpen,
    navigateToView,
    onNewChat,
    openSettings
  } = deps

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void =>
      applyShortcut(event, {
        activeView,
        isSettingsOpen,
        isProviderDialogOpen,
        isNewProjectDialogOpen,
        closeProviderDialog,
        setIsSettingsOpen,
        setIsNewProjectDialogOpen,
        navigateToView,
        onNewChat
      })
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    activeView,
    closeProviderDialog,
    isNewProjectDialogOpen,
    isProviderDialogOpen,
    isSettingsOpen,
    navigateToView,
    onNewChat,
    setIsNewProjectDialogOpen,
    setIsSettingsOpen
  ])

  useEffect(() => {
    let active = true
    let consuming = false
    const consumeMenuBarAction = async (): Promise<void> => {
      if (consuming) return
      consuming = true
      try {
        const action = await rendererApi.consumeMenuBarAction()
        if (!active || !action) return
        if (action === 'new-chat') {
          navigateToView('chat')
          await onNewChat()
        } else if (action === 'open-settings') {
          openSettings()
        }
      } catch {
        // The main process may be shutting down while a focus event is being handled.
      } finally {
        consuming = false
      }
    }
    const onWindowFocus = (): void => {
      void consumeMenuBarAction()
    }

    window.addEventListener('focus', onWindowFocus)
    void consumeMenuBarAction()
    return () => {
      active = false
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [navigateToView, onNewChat, openSettings, rendererApi])
}
