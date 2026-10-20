import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { checkForAppUpdate, RELEASES_PAGE_URL, RELEASES_REPOSITORY } from '../app-update-check'

export interface AppIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  getVersion: () => string
  openExternal: (url: string) => Promise<void>
}

export function registerAppIpc(options: AppIpcOptions): void {
  const { ipcMain } = options
  const app = { getVersion: options.getVersion }
  const shell = { openExternal: options.openExternal }
  ipcMain.handle(IPC.app.checkForUpdates, async () => checkForAppUpdate(app.getVersion()))
  ipcMain.handle(IPC.app.openReleasesPage, async (_, url: unknown) => {
    // Only Phi's own release pages; anything else falls back to the latest release.
    const target =
      typeof url === 'string' &&
      url.startsWith(`https://github.com/${RELEASES_REPOSITORY}/releases/`)
        ? url
        : RELEASES_PAGE_URL
    await shell.openExternal(target)
  })
}
