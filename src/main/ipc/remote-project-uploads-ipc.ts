import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { isRecord } from '../../shared/guards'
import type { RemoteProjectUploadService } from '../agent/remote-project-upload'

export interface RemoteProjectUploadsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  uploads: Pick<RemoteProjectUploadService, 'prepare' | 'start' | 'list' | 'cancel' | 'retry'>
}

export function registerRemoteProjectUploadPreparationIpc(
  options: RemoteProjectUploadsIpcOptions
): void {
  const ipcMain = options.ipcMain
  const remoteProjectUploads = options.uploads

  ipcMain.handle(
    IPC.remoteProjectUploads.prepare,
    async (_, projectId: unknown, value: unknown) => {
      if (typeof projectId !== 'string' || !projectId || !isRecord(value)) {
        throw new Error('远程项目上传请求无效')
      }
      const sourcePaths = value.sourcePaths
      const destinationDirectory = value.destinationDirectory
      if (
        Object.keys(value).some((key) => key !== 'sourcePaths' && key !== 'destinationDirectory') ||
        !Array.isArray(sourcePaths) ||
        sourcePaths.some((path) => typeof path !== 'string') ||
        (destinationDirectory !== undefined && typeof destinationDirectory !== 'string')
      ) {
        throw new Error('远程项目上传只能包含本机来源和项目内落点')
      }
      return remoteProjectUploads.prepare(projectId, {
        sourcePaths,
        ...(typeof destinationDirectory === 'string' ? { destinationDirectory } : {})
      })
    }
  )
  ipcMain.handle(
    IPC.remoteProjectUploads.start,
    async (_, projectId: unknown, jobId: unknown, value: unknown) => {
      if (typeof projectId !== 'string' || !projectId || typeof jobId !== 'string' || !jobId) {
        throw new Error('远程项目上传任务无效')
      }
      if (
        value !== undefined &&
        (!isRecord(value) ||
          Object.keys(value).some((key) => key !== 'confirmed') ||
          (value.confirmed !== undefined && typeof value.confirmed !== 'boolean'))
      ) {
        throw new Error('远程项目上传确认无效')
      }
      return remoteProjectUploads.start(projectId, jobId, {
        confirmed: isRecord(value) && value.confirmed === true
      })
    }
  )
}

export function registerRemoteProjectUploadListIpc(options: RemoteProjectUploadsIpcOptions): void {
  const ipcMain = options.ipcMain
  const remoteProjectUploads = options.uploads

  ipcMain.handle(IPC.remoteProjectUploads.list, () => remoteProjectUploads.list())
}

export function registerRemoteProjectUploadControlIpc(
  options: RemoteProjectUploadsIpcOptions
): void {
  const ipcMain = options.ipcMain
  const remoteProjectUploads = options.uploads

  ipcMain.handle(IPC.remoteProjectUploads.cancel, async (_, jobId: unknown) => {
    if (typeof jobId !== 'string' || !jobId) throw new Error('远程项目上传任务无效')
    await remoteProjectUploads.cancel(jobId)
  })
  ipcMain.handle(IPC.remoteProjectUploads.retry, async (_, jobId: unknown) => {
    if (typeof jobId !== 'string' || !jobId) throw new Error('远程项目上传任务无效')
    return remoteProjectUploads.retry(jobId)
  })
}
