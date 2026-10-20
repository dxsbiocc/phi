import type { BrowserWindow } from 'electron'

import type { MenuBarAction } from '../../shared/menuBarTypes'
import type { MenuBarController } from '../menu-bar-controller'
import type { StartupSplashWindow } from '../startup-splash'

export class MainWindowState {
  private currentMainWindow: BrowserWindow | null = null
  private currentStartupSplashWindow: StartupSplashWindow | null = null
  private currentMenuBarController: MenuBarController | null = null
  private pendingMenuBarAction: MenuBarAction | null = null
  private mainWindowCleanupStarted = false
  private mainWindowCleanupPromise: Promise<void> | null = null

  get mainWindow(): BrowserWindow | null {
    return this.currentMainWindow
  }

  get startupSplashWindow(): StartupSplashWindow | null {
    return this.currentStartupSplashWindow
  }

  get menuBarController(): MenuBarController | null {
    return this.currentMenuBarController
  }

  get cleanupStarted(): boolean {
    return this.mainWindowCleanupStarted
  }

  get cleanupPromise(): Promise<void> | null {
    return this.mainWindowCleanupPromise
  }

  setMainWindow(window: BrowserWindow): void {
    this.currentMainWindow = window
  }

  clearMainWindow(window: BrowserWindow): void {
    if (this.currentMainWindow === window) {
      this.currentMainWindow = null
    }
  }

  setStartupSplashWindow(window: StartupSplashWindow | null): void {
    this.currentStartupSplashWindow = window
  }

  takeStartupSplashWindow(): StartupSplashWindow | null {
    const splash = this.currentStartupSplashWindow
    this.currentStartupSplashWindow = null
    return splash
  }

  setMenuBarController(controller: MenuBarController | null): void {
    this.currentMenuBarController = controller
  }

  destroyMenuBarController(): void {
    this.currentMenuBarController?.destroy()
    this.currentMenuBarController = null
  }

  queueMenuBarAction(action: MenuBarAction): void {
    this.pendingMenuBarAction = action
  }

  consumeMenuBarAction(): MenuBarAction | null {
    const action = this.pendingMenuBarAction
    this.pendingMenuBarAction = null
    return action
  }

  beginCleanup(disposeBeforeCleanup: () => void, cleanup: () => Promise<void>): Promise<void> {
    if (this.mainWindowCleanupPromise) return this.mainWindowCleanupPromise
    this.mainWindowCleanupStarted = true
    disposeBeforeCleanup()
    this.mainWindowCleanupPromise = Promise.resolve().then(cleanup)
    return this.mainWindowCleanupPromise
  }

  resetCleanup(): void {
    this.mainWindowCleanupStarted = false
    this.mainWindowCleanupPromise = null
  }
}
