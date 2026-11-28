import path from 'node:path'

import type { BrowserWindow, IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { RELEASES_PAGE_URL, RELEASES_REPOSITORY } from '../app-update-check'
import { createAppUpdateManager } from '../app-updater'
import { browserPolicyContext, externalBrowserUrl } from '../browser/browser-policy'
import { desktopFetch } from '../agent/desktop-fetch'

export interface AppIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  getVersion?: () => string
  openExternal?: (url: string) => Promise<void>
  app?: {
    getVersion: () => string
    quit: () => void
    once: (event: 'will-quit', listener: () => void) => unknown
  }
  shell?: {
    openExternal: (url: string) => Promise<void>
    openPath: (filePath: string) => Promise<string>
  }
  updatesDir?: string
  getMainWindow?: () => Pick<BrowserWindow, 'isDestroyed' | 'webContents'> | null
}

export function registerAppIpc(options: AppIpcOptions): void {
  const { ipcMain } = options
  const getVersion = options.getVersion ?? (() => options.app?.getVersion() ?? '0.0.0')
  const openExternal =
    options.openExternal ?? ((url: string) => options.shell?.openExternal(url) ?? Promise.resolve())
  const openPath = (filePath: string): Promise<string> =>
    options.shell ? options.shell.openPath(filePath) : Promise.resolve('')
  const quitApp = (): void => {
    options.app?.quit()
  }
  const onWillQuit = (listener: () => void): void => {
    if (options.app) {
      options.app.once('will-quit', listener)
    } else {
      listener()
    }
  }

  const updater = createAppUpdateManager({
    updatesDir: options.updatesDir ?? path.resolve('.phi-updates'),
    getVersion,
    // Chromium networking, so the system proxy applies to checks and downloads too.
    fetchImpl: desktopFetch(),
    openPath,
    quitApp,
    onWillQuit,
    onStateChange: (state) => {
      const win = options.getMainWindow?.()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.app.updateDownloadState, state)
      }
    }
  })

  ipcMain.handle(IPC.app.checkForUpdates, async () => updater.check())
  ipcMain.handle(IPC.app.getUpdateDownloadState, async () => updater.getState())
  ipcMain.handle(IPC.app.downloadUpdate, async () => updater.download())
  ipcMain.handle(IPC.app.cancelUpdateDownload, async () => updater.cancelDownload())
  ipcMain.handle(IPC.app.installUpdate, async () => updater.install())
  ipcMain.handle(IPC.app.openReleasesPage, async (_, url: unknown) => {
    // Only Phi's own release pages; anything else falls back to the latest release.
    const target =
      typeof url === 'string' &&
      url.startsWith(`https://github.com/${RELEASES_REPOSITORY}/releases/`)
        ? url
        : RELEASES_PAGE_URL
    await openExternal(target)
  })
  ipcMain.handle(IPC.app.openWebUrl, async (_, input: unknown) => {
    const url = externalBrowserUrl(input, browserPolicyContext())
    if (!url) throw new Error('This address cannot be opened in the default browser')
    await openExternal(url)
  })
}
