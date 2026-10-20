import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'

export interface SystemIpcOptions {
  ipcMain: Pick<IpcMain, 'on'>
}

export function registerSystemIpc(options: SystemIpcOptions): void {
  const { ipcMain } = options
  ipcMain.on(IPC.system.ping, () => console.log('pong'))
}
