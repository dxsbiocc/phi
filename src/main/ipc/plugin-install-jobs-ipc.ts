import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { PluginInstallJobs } from '../agent/plugins/plugin-install-jobs'

export interface PluginInstallJobsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  pluginInstallJobs: Pick<PluginInstallJobs, 'list'>
}

export function registerPluginInstallJobsIpc(options: PluginInstallJobsIpcOptions): void {
  const pluginInstallJobs = options.pluginInstallJobs
  options.ipcMain.handle(IPC.pluginInstallJobs.list, () => pluginInstallJobs.list())
}
