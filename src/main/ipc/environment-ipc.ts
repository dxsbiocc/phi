import type { BrowserWindow, Dialog, IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { readAppSettings } from '../agent/app-settings'
import type { createBackgroundEnvironment } from '../agent/environment/background'
import { nativeUiCopy } from '../native-ui-copy'

export interface EnvironmentIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  environment: Pick<
    ReturnType<typeof createBackgroundEnvironment>,
    'get' | 'redetect' | 'dismissSummary' | 'setToolPath'
  >
  getActiveWindow: () => BrowserWindow | null
  dialog: Pick<Dialog, 'showOpenDialog'>
  getUiLanguage: () => ReturnType<typeof readAppSettings>['uiLanguage']
}

export function registerEnvironmentIpc(registrationOptions: EnvironmentIpcOptions): void {
  const {
    ipcMain,
    environment: backgroundEnvironment,
    getActiveWindow,
    dialog,
    getUiLanguage
  } = registrationOptions
  ipcMain.handle(IPC.environment.get, () => backgroundEnvironment.get())
  ipcMain.handle(IPC.environment.redetect, () => backgroundEnvironment.redetect())
  ipcMain.handle(IPC.environment.dismissSummary, () => backgroundEnvironment.dismissSummary())
  ipcMain.handle(IPC.environment.setToolPath, async (_, toolId: unknown, path: unknown) => {
    if (typeof toolId !== 'string' || !toolId.trim()) {
      throw new Error('工具 id 无效')
    }
    if (path !== null && typeof path !== 'string') {
      throw new Error('工具路径必须是字符串或 null')
    }
    return backgroundEnvironment.setToolPath(
      toolId as Parameters<typeof backgroundEnvironment.setToolPath>[0],
      path
    )
  })
  ipcMain.handle(IPC.environment.pickBinary, async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(getUiLanguage())
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectExecutable,
      buttonLabel: dialogCopy.select,
      properties: ['openFile']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}
