import type { BrowserWindow, Dialog, IpcMain, Shell } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { readAppSettings } from '../agent/app-settings'
import { isRemoteProjectAnchorPath } from '../agent/remote-project-anchor'
import type { createLocalFileAccessControl } from '../local-file-access-control'
import type { createLocalFileIcons } from '../local-file-icons'
import type { createLocalFilePreviews } from '../local-file-previews'
import { nativeUiCopy } from '../native-ui-copy'

export interface FilesIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  dialog: Pick<Dialog, 'showOpenDialog'>
  shell: Pick<Shell, 'showItemInFolder' | 'openPath'>
  agentDir: string
  getCurrentCwd: () => string
  getActiveWindow: () => BrowserWindow | null
  getUiLanguage: () => ReturnType<typeof readAppSettings>['uiLanguage']
  access: ReturnType<typeof createLocalFileAccessControl>
  icons: ReturnType<typeof createLocalFileIcons>
  previews: ReturnType<typeof createLocalFilePreviews>
}

export function registerFileOpenIpc(registrationOptions: FilesIpcOptions): void {
  const { ipcMain, shell, access, icons } = registrationOptions
  const assertRevealPathAllowed = access.assertRevealPathAllowed.bind(access)
  const getLocalFileIconDataUrl = icons.getLocalFileIconDataUrl.bind(icons)
  const openLocalFilePath = (filePath: string): Promise<void> => {
    const target = access.assertLocalFilePathAllowed(filePath, '打开', { resolveSymlinks: true })
    return shell.openPath(target).then((errorMessage) => {
      if (errorMessage) {
        throw new Error(errorMessage)
      }
    })
  }

  ipcMain.handle(IPC.files.reveal, async (_, filePath: string) => {
    shell.showItemInFolder(assertRevealPathAllowed(filePath))
  })
  ipcMain.handle(IPC.files.openPath, async (_, filePath: string) => {
    await openLocalFilePath(filePath)
  })
  ipcMain.handle(IPC.files.getIcon, async (_, filePath: string) => {
    return getLocalFileIconDataUrl(filePath)
  })
}

export function registerFilePickerIpc(registrationOptions: FilesIpcOptions): void {
  const {
    ipcMain,
    dialog,
    getActiveWindow,
    getUiLanguage,
    getCurrentCwd,
    agentDir: AGENT_DIR
  } = registrationOptions
  ipcMain.handle(IPC.files.pickInput, async () => {
    if (isRemoteProjectAnchorPath(getCurrentCwd(), AGENT_DIR)) {
      throw new Error('远程项目文件选择暂不可用；不会打开本机会话目录')
    }
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(getUiLanguage())
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectInput,
      buttonLabel: dialogCopy.select,
      defaultPath: getCurrentCwd() || undefined,
      properties: ['openFile', 'openDirectory', 'multiSelections']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle(IPC.files.pickLocalUpload, async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(getUiLanguage())
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectUpload,
      buttonLabel: dialogCopy.select,
      properties: ['openFile', 'openDirectory', 'multiSelections']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
}

export function registerFilePreviewIpc(registrationOptions: FilesIpcOptions): void {
  const { ipcMain, previews } = registrationOptions
  const createFilePreview = previews.createFilePreview.bind(previews)
  ipcMain.handle(IPC.files.preview, async (_, filePath: string) => {
    return createFilePreview(filePath)
  })
}

export function registerFileBrowsingIpc(registrationOptions: FilesIpcOptions): void {
  const { ipcMain, access, previews } = registrationOptions
  const createFileHoverPreview = previews.createFileHoverPreview.bind(previews)
  const statLocalPaths = access.statLocalPaths.bind(access)
  const createDirectoryListing = access.createDirectoryListing.bind(access)
  ipcMain.handle(IPC.files.hoverPreview, async (_, filePath: string) => {
    return createFileHoverPreview(filePath)
  })
  ipcMain.handle(IPC.files.statLocalPaths, async (_, cwd: unknown, paths: unknown) => {
    return statLocalPaths(cwd, paths)
  })
  ipcMain.handle(IPC.files.listDirectory, async (_, dirPath: string) => {
    return createDirectoryListing(dirPath)
  })
}
