import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { EnvironmentBuilds } from '../agent/content/environment-builds'

export interface EnvironmentBuildsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  environmentBuilds: Pick<EnvironmentBuilds, 'list' | 'cancel'>
}

export function registerEnvironmentBuildsIpc(options: EnvironmentBuildsIpcOptions): void {
  const ipcMain = options.ipcMain
  const environmentBuilds = options.environmentBuilds

  ipcMain.handle(IPC.environmentBuilds.list, () => environmentBuilds.list())
  ipcMain.handle(IPC.environmentBuilds.cancel, (_event, envId: unknown) => {
    if (typeof envId !== 'string' || envId.length === 0) throw new Error('envId is required')
    environmentBuilds.cancel(envId)
  })
}
