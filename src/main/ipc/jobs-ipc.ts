import type { IpcMain } from 'electron'

import type { BackgroundAgentJob, BackgroundShellJob } from '../../shared/backgroundJobTypes'
import { IPC } from '../../shared/ipcChannels'
export interface JobsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  operations: {
    listAgentJobs: () => Promise<BackgroundAgentJob[]>
    listShellJobs: () => Promise<BackgroundShellJob[]>
    stopShellJob: (agentSessionId: unknown, jobId: unknown) => Promise<void>
  }
}

export function registerJobsIpc(options: JobsIpcOptions): void {
  const ipcMain = options.ipcMain
  const listBackgroundAgentJobs = options.operations.listAgentJobs
  const listBackgroundShellJobs = options.operations.listShellJobs
  const stopBackgroundShellJob = options.operations.stopShellJob

  ipcMain.handle(IPC.jobs.listAgents, listBackgroundAgentJobs)
  ipcMain.handle(IPC.jobs.listShell, listBackgroundShellJobs)
  ipcMain.handle(IPC.jobs.stopShell, async (_, agentSessionId: unknown, jobId: unknown) => {
    await stopBackgroundShellJob(agentSessionId, jobId)
  })
}
