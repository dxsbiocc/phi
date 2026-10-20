import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { MenuBarAction } from '../../shared/menuBarTypes'

export interface MenuBarIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  requireMainWindowRenderer: (event: IpcMainInvokeEvent) => unknown
  getPendingAction: () => MenuBarAction | null
  setPendingAction: (action: MenuBarAction | null) => void
}

export function registerMenuBarIpc(options: MenuBarIpcOptions): void {
  const { ipcMain, requireMainWindowRenderer, getPendingAction, setPendingAction } = options
  ipcMain.handle(IPC.menuBar.consumeAction, (event): MenuBarAction | null => {
    requireMainWindowRenderer(event)
    const action = getPendingAction()
    setPendingAction(null)
    return action
  })
}
