import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

import { IPC } from '../../shared/ipcChannels'

export interface WindowIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  getActiveWindow: () => BrowserWindow | null
  requireMainWindowRenderer: (event: IpcMainInvokeEvent) => BrowserWindow
  getWindowStartup: (
    window: BrowserWindow
  ) => { rendererReady: (background: unknown) => void } | undefined
}

export function registerWindowIpc(options: WindowIpcOptions): void {
  const { ipcMain, getActiveWindow, requireMainWindowRenderer, getWindowStartup } = options
  ipcMain.handle(IPC.window.close, () => {
    getActiveWindow()?.close()
  })
  ipcMain.handle(IPC.window.minimize, () => {
    getActiveWindow()?.minimize()
  })
  ipcMain.handle(IPC.window.toggleFullscreen, () => {
    const window = getActiveWindow()
    if (!window) return
    window.setFullScreen(!window.isFullScreen())
  })
  ipcMain.handle(IPC.window.getFullscreen, (event) => {
    return requireMainWindowRenderer(event).isFullScreen()
  })
  ipcMain.handle(IPC.window.rendererReady, (event, background: unknown) => {
    const window = requireMainWindowRenderer(event)
    getWindowStartup(window)?.rendererReady(background)
  })
}
