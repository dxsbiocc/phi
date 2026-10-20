import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { MenuBarAction } from '../../shared/menuBarTypes'

export interface MenuBarIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  requireMainWindowRenderer: (event: IpcMainInvokeEvent) => unknown
  consumePendingAction: () => MenuBarAction | null
}

export function registerMenuBarIpc(options: MenuBarIpcOptions): void {
  const { ipcMain, requireMainWindowRenderer, consumePendingAction } = options
  ipcMain.handle(IPC.menuBar.consumeAction, (event): MenuBarAction | null => {
    requireMainWindowRenderer(event)
    return consumePendingAction()
  })
}
