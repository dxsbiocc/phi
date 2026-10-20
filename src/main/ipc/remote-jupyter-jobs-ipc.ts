import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { RemoteJupyterStartJobs } from '../agent/notebook/remote-jupyter-start-jobs'

export interface RemoteJupyterJobsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  jobs: Pick<RemoteJupyterStartJobs, 'list'>
}

export function registerRemoteJupyterJobsIpc(options: RemoteJupyterJobsIpcOptions): void {
  const { ipcMain, jobs: remoteJupyterStartJobs } = options
  ipcMain.handle(IPC.remoteJupyterJobs.list, () => remoteJupyterStartJobs.list())
}
