import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { BackgroundJobOperations } from '../agent/jobs/background-job-operations'
import {
  readBackgroundJobHistory,
  writeBackgroundJobHistory
} from '../agent/jobs/background-job-history-store'
export interface JobsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  requireMainWindowRenderer: (event: IpcMainInvokeEvent) => void
  operations: Omit<BackgroundJobOperations, 'dispose'>
}

export function registerJobsIpc(options: JobsIpcOptions): void {
  const ipcMain = options.ipcMain
  const listBackgroundAgentJobs = options.operations.listAgentJobs
  const listBackgroundShellJobs = options.operations.listShellJobs
  const stopBackgroundShellJob = options.operations.stopShellJob

  ipcMain.handle(IPC.jobs.listAgents, listBackgroundAgentJobs)
  ipcMain.handle(IPC.jobs.readHistory, () => readBackgroundJobHistory())
  ipcMain.handle(IPC.jobs.writeHistory, (_, value: unknown) => writeBackgroundJobHistory(value))
  ipcMain.handle(IPC.jobs.listShell, listBackgroundShellJobs)
  ipcMain.handle(IPC.jobs.startShell, (event, request: unknown) => {
    options.requireMainWindowRenderer(event)
    return options.operations.startShellJob(request)
  })
  ipcMain.handle(IPC.jobs.stopShell, async (event, agentSessionId: unknown, jobId: unknown) => {
    options.requireMainWindowRenderer(event)
    await stopBackgroundShellJob(agentSessionId, jobId)
  })
}
