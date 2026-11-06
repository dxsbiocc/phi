/**
 * Keeps the macOS main window alive when the user closes it without quitting.
 *
 * Destroying the window throws away the renderer: reopening from the Dock then pays a full
 * page load and lands on the home view, losing the open project, conversation, panels and
 * scroll positions. On macOS a close that is not part of quitting hides the window instead;
 * `reveal` brings the same window, with the same renderer, back. Quitting still closes it.
 */

export interface PreventableCloseEvent {
  preventDefault(): void
}

export interface RetainableWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFullScreen(): boolean
  setFullScreen(flag: boolean): void
  once(event: 'leave-full-screen', listener: () => void): unknown
  hide(): void
  show(): void
  restore(): void
  focus(): void
  close(): void
  readonly webContents: { isCrashed(): boolean; reload(): void }
}

export type MainWindowCloseOutcome = 'hidden' | 'closing'

export interface MainWindowRetention {
  /** Called from `before-quit`; every later close really closes. */
  markQuitting(): void
  isQuitting(): boolean
  /** Handles a window `close` event. Returns 'closing' when the window should be released. */
  handleClose(window: RetainableWindow, event: PreventableCloseEvent): MainWindowCloseOutcome
  /** Closes the window for real, e.g. after a startup failure the user chose not to retry. */
  closeForReal(window: RetainableWindow): void
  /** Hides a visible window, leaving fullscreen first. */
  hide(window: RetainableWindow | null | undefined): void
  /** Shows a retained window. Returns false when there is none to show. */
  reveal(window: RetainableWindow | null | undefined): boolean
}

export function createMainWindowRetention(platform: NodeJS.Platform): MainWindowRetention {
  let quitting = false
  const releasing = new WeakSet<RetainableWindow>()

  function hide(window: RetainableWindow): void {
    if (!window.isFullScreen()) {
      window.hide()
      return
    }
    // Hiding a fullscreen window leaves an empty black Space behind; leave fullscreen first.
    window.once('leave-full-screen', () => {
      if (!window.isDestroyed()) window.hide()
    })
    window.setFullScreen(false)
  }

  return {
    markQuitting() {
      quitting = true
    },
    isQuitting: () => quitting,
    handleClose(window, event) {
      if (platform !== 'darwin' || quitting || releasing.has(window)) return 'closing'
      event.preventDefault()
      hide(window)
      return 'hidden'
    },
    hide(window) {
      if (window && !window.isDestroyed() && window.isVisible()) hide(window)
    },
    closeForReal(window) {
      if (window.isDestroyed()) return
      releasing.add(window)
      window.close()
    },
    reveal(window) {
      if (!window || window.isDestroyed()) return false
      // A renderer that died while the window was hidden would reappear blank.
      if (window.webContents.isCrashed()) window.webContents.reload()
      if (window.isMinimized()) window.restore()
      if (!window.isVisible()) window.show()
      window.focus()
      return true
    }
  }
}
