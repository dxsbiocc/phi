import { basename } from 'node:path'

import { BrowserWindow, dialog, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { readAppSettings } from '../agent/app-settings'
import {
  downloadWrapperResultToPath,
  validateWrapperResultDownloadRequest
} from '../agent/wrappers/remote-result-download'
import { previewWrapperResult, readWrapperResultRange } from '../agent/wrappers/remote-result-read'
import { listWrapperResultDirectory } from '../agent/wrappers/remote-results'
import type { createWrapperResultReadControl } from '../agent/wrappers/remote-result-read-control'
import { nativeUiCopy } from '../native-ui-copy'

export type WrapperResultDownloads = Map<
  string,
  { controller: AbortController; phase: 'downloading' | 'verifying' | 'saving' }
>

export interface WrapperResultsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  windows: {
    getActiveWindow: () => BrowserWindow | null
    requireMainWindowRenderer: (event: IpcMainInvokeEvent) => BrowserWindow
  }
  remote: {
    observe: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>
    requestProjectId: (request: unknown) => string
  }
  reads: ReturnType<typeof createWrapperResultReadControl>
  downloads: WrapperResultDownloads
}

export function registerWrapperResultsIpc(options: WrapperResultsIpcOptions): void {
  registerWrapperResultReadIpc(options)
  registerWrapperResultDownloadIpc(options)
}

function registerWrapperResultReadIpc(options: WrapperResultsIpcOptions): void {
  const ipcMain = options.ipcMain
  const remoteConnectionTracker = { observe: options.remote.observe }
  const remoteRequestProjectId = options.remote.requestProjectId
  const runWrapperResultRead = options.reads.run
  const wrapperResultReadControllers = options.reads.controllers

  ipcMain.handle(IPC.wrapperResults.listDirectory, async (_, request: unknown) =>
    remoteConnectionTracker.observe(remoteRequestProjectId(request), () =>
      listWrapperResultDirectory(request)
    )
  )
  ipcMain.handle(IPC.wrapperResults.preview, async (_, request: unknown) =>
    runWrapperResultRead(request, previewWrapperResult)
  )
  ipcMain.handle(IPC.wrapperResults.readRange, async (_, request: unknown) =>
    runWrapperResultRead(request, readWrapperResultRange)
  )
  ipcMain.handle(IPC.wrapperResults.cancelRead, async (_, requestId: unknown) => {
    if (typeof requestId !== 'string') throw new Error('Wrapper 结果读取请求 ID 无效')
    const controller = wrapperResultReadControllers.get(requestId)
    controller?.abort()
    return controller !== undefined
  })
}

function registerWrapperResultDownloadIpc(options: WrapperResultsIpcOptions): void {
  const ipcMain = options.ipcMain
  const getActiveWindow = options.windows.getActiveWindow
  const requireMainWindowRenderer = options.windows.requireMainWindowRenderer
  const remoteConnectionTracker = { observe: options.remote.observe }
  const remoteRequestProjectId = options.remote.requestProjectId
  const wrapperResultDownloads = options.downloads

  ipcMain.handle(IPC.wrapperResults.download, async (event, request: unknown) => {
    requireMainWindowRenderer(event)
    const checked = validateWrapperResultDownloadRequest(request)
    const { requestId } = checked
    if (wrapperResultDownloads.has(requestId)) throw new Error('Wrapper 下载请求 ID 正在使用')
    const name = basename(checked.path!)
    const window = BrowserWindow.fromWebContents?.(event.sender) ?? getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.SaveDialogOptions = {
      title: dialogCopy.saveResult,
      buttonLabel: dialogCopy.save,
      defaultPath: name && name !== '.' && name !== '..' ? name : 'remote-result'
    }
    const chosen = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' as const }
    if (wrapperResultDownloads.has(requestId)) throw new Error('Wrapper 下载请求 ID 正在使用')

    const controller = new AbortController()
    const active: {
      controller: AbortController
      phase: 'downloading' | 'verifying' | 'saving'
    } = { controller, phase: 'downloading' }
    wrapperResultDownloads.set(requestId, active)
    try {
      return await remoteConnectionTracker.observe(remoteRequestProjectId(request), async () => {
        try {
          return await downloadWrapperResultToPath(checked, chosen.filePath!, {
            signal: controller.signal,
            onProgress: (progress) => {
              active.phase = progress.phase
              try {
                if (event.sender.isDestroyed?.()) controller.abort()
                else event.sender.send?.(IPC.wrapperResults.downloadProgress, progress)
              } catch {
                controller.abort()
              }
            }
          })
        } catch (error) {
          if (controller.signal.aborted) throw new Error('Wrapper 下载已取消')
          throw error
        }
      })
    } finally {
      wrapperResultDownloads.delete(requestId)
    }
  })
  ipcMain.handle(IPC.wrapperResults.cancelDownload, async (event, requestId: unknown) => {
    requireMainWindowRenderer(event)
    if (typeof requestId !== 'string') throw new Error('Wrapper 下载请求 ID 无效')
    const active = wrapperResultDownloads.get(requestId)
    if (!active || active.phase === 'saving') return false
    active.controller.abort()
    return true
  })
}
