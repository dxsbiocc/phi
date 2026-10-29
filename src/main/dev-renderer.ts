import type { BrowserWindow } from 'electron'

/**
 * Loads the electron-vite dev server with an empty HTTP cache.
 *
 * Vite serves pre-bundled deps as `immutable`, keyed only by `?v=<browserHash>`. A re-optimization
 * can change chunk layout under the same hash, so a cached old chunk mixes with new ones and the
 * page ends up with two copies of a module (seen as a second MUI ThemeContext: the composer fell
 * back to the default light theme). Clearing only the HTTP cache keeps storage and logins intact.
 */
export async function loadFreshDevRenderer(window: BrowserWindow, url: string): Promise<void> {
  await window.webContents.session.clearCache()
  await window.loadURL(url)
}
