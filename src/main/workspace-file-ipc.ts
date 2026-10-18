import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent, Shell } from 'electron'
import { basename } from 'node:path'
import type { WorkspaceTextSaveResult } from '../shared/workspaceFileOperations'
import { DEFAULT_UI_LANGUAGE, type UiLanguage } from '../shared/uiLanguage'
import { nativeUiCopy } from './native-ui-copy'

import { validateWorkspaceMarkdownSaveRequest } from './workspace-markdown-file'
import { saveWorkspaceTextFile, validateWorkspaceTextSaveRequest } from './workspace-text-file'
import {
  deleteWorkspaceFile,
  renameWorkspaceFile,
  validateWorkspaceFileOperation
} from './workspace-file-operations'
import {
  downloadRemoteWorkspaceFileToPath,
  validateRemoteWorkspaceDownloadRequest
} from './agent/remote-workspace-file-download'

export function registerWorkspaceFileIpc(options: {
  ipcMain: Pick<IpcMain, 'handle'>
  dialog: Pick<Dialog, 'showSaveDialog'>
  shell: Pick<Shell, 'trashItem'>
  getUiLanguage?: () => UiLanguage
  requireRenderer: (event: IpcMainInvokeEvent) => BrowserWindow
  requireLocalWorkspaceRoot: (rootPath: string) => void
  observeRemote: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>
  downloads: Map<
    string,
    { controller: AbortController; phase: 'downloading' | 'verifying' | 'saving' }
  >
}): void {
  for (const [channel, validate] of [
    ['files:saveTextFile', validateWorkspaceTextSaveRequest],
    ['files:saveMarkdownFile', validateWorkspaceMarkdownSaveRequest]
  ] as const) {
    options.ipcMain.handle(channel, async (event, input: unknown) => {
      options.requireRenderer(event)
      const request = validate(input)
      const requireScope = (): void => {
        options.requireRenderer(event)
        if (request.kind === 'local') options.requireLocalWorkspaceRoot(request.rootPath)
      }
      requireScope()
      const operation = (): Promise<WorkspaceTextSaveResult> =>
        saveWorkspaceTextFile(request, { beforeWrite: requireScope })
      return request.kind === 'remote'
        ? options.observeRemote(request.projectId, operation)
        : operation()
    })
  }
  options.ipcMain.handle('files:renameWorkspaceFile', async (event, input: unknown) => {
    options.requireRenderer(event)
    const request = validateWorkspaceFileOperation(input, true)
    if (request.kind === 'local') options.requireLocalWorkspaceRoot(request.rootPath)
    const operation = (): Promise<{ path: string }> => renameWorkspaceFile(request)
    return request.kind === 'remote'
      ? options.observeRemote(request.projectId, operation)
      : operation()
  })
  options.ipcMain.handle('files:deleteWorkspaceFile', async (event, input: unknown) => {
    options.requireRenderer(event)
    const request = validateWorkspaceFileOperation(input)
    if (request.kind === 'local') options.requireLocalWorkspaceRoot(request.rootPath)
    const operation = (): Promise<void> =>
      deleteWorkspaceFile(request, { trashItem: (path) => options.shell.trashItem(path) })
    return request.kind === 'remote'
      ? options.observeRemote(request.projectId, operation)
      : operation()
  })
  options.ipcMain.handle('remoteWorkspace:download', async (event, input: unknown) => {
    const window = options.requireRenderer(event)
    const request = validateRemoteWorkspaceDownloadRequest(input)
    const { requestId } = request
    if (options.downloads.has(requestId)) throw new Error('下载请求 ID 正在使用')
    const copy = nativeUiCopy(options.getUiLanguage?.() ?? DEFAULT_UI_LANGUAGE)
    const chosen = await options.dialog.showSaveDialog(window, {
      title: copy.saveRemoteFile,
      buttonLabel: copy.save,
      defaultPath: basename(request.path) || 'remote-file'
    })
    if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' as const }
    options.requireRenderer(event)
    if (options.downloads.has(requestId)) throw new Error('下载请求 ID 正在使用')
    const controller = new AbortController()
    const active: {
      controller: AbortController
      phase: 'downloading' | 'verifying' | 'saving'
    } = { controller, phase: 'downloading' }
    options.downloads.set(requestId, active)
    try {
      return await options.observeRemote(request.projectId, () =>
        downloadRemoteWorkspaceFileToPath(request, chosen.filePath!, {
          signal: controller.signal,
          onProgress: (progress) => {
            active.phase = progress.phase
            try {
              if (event.sender.isDestroyed()) controller.abort()
              else event.sender.send('wrapperResults:downloadProgress', progress)
            } catch {
              controller.abort()
            }
          }
        })
      )
    } catch (error) {
      if (controller.signal.aborted) throw new Error('远程文件下载已取消')
      throw error
    } finally {
      options.downloads.delete(requestId)
    }
  })
}
