import type { Event, WebContents, WebPreferences } from 'electron'

function allowedPreviewUrl(urlValue: string, ownsUrl: (url: string) => boolean): boolean {
  try {
    const url = new URL(urlValue)
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.pathname === '/' &&
      ownsUrl(urlValue)
    )
  } catch {
    return false
  }
}

function hardenPreferences(preferences: WebPreferences): void {
  delete preferences.preload
  preferences.sandbox = true
  preferences.contextIsolation = true
  preferences.nodeIntegration = false
  preferences.nodeIntegrationInWorker = false
  preferences.nodeIntegrationInSubFrames = false
  preferences.webSecurity = true
  preferences.webviewTag = false
  preferences.allowRunningInsecureContent = false
  preferences.navigateOnDragDrop = false
  preferences.devTools = false
}

function allowedPreviewOrigin(urlValue: string, ownsUrl: (url: string) => boolean): boolean {
  try {
    const url = new URL(urlValue)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && ownsUrl(`${url.origin}/`)
  } catch {
    return false
  }
}

function hardenGuest(guest: WebContents, ownsUrl: (url: string) => boolean): void {
  // Read the session once: touching a WebContents property after 'destroyed' throws in Electron,
  // and an uncaught throw in the main process shows a native error dialog.
  const guestSession = guest.session
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  guestSession.setPermissionCheckHandler(() => false)
  guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const denyDownload = (event: Event): void => event.preventDefault()
  guestSession.on('will-download', denyDownload)
  guest.once('destroyed', () => guestSession.off('will-download', denyDownload))
  const keepOnGateway = (event: Event, url: string): void => {
    if (!allowedPreviewOrigin(url, ownsUrl)) event.preventDefault()
  }
  guest.on('will-navigate', keepOnGateway)
  guest.on('will-redirect', keepOnGateway)
}

export function installOfficeWebviewSecurity(
  host: WebContents,
  ownsUrl: (url: string) => boolean
): void {
  host.on('will-attach-webview', (event, preferences, params) => {
    if (!allowedPreviewUrl(params.src, ownsUrl)) {
      event.preventDefault()
      return
    }
    hardenPreferences(preferences)
  })
  host.on('did-attach-webview', (_event, guest) => hardenGuest(guest, ownsUrl))
}
