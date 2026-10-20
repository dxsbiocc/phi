import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { createWebLinkPreviewService } from '../web-link-preview'

const webLinkPreviews = createWebLinkPreviewService()

export interface WebLinkIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  requireMainWindowRenderer: (event: IpcMainInvokeEvent) => unknown
}

export function registerWebLinkIpc(options: WebLinkIpcOptions): void {
  const { ipcMain, requireMainWindowRenderer } = options
  ipcMain.handle(IPC.webLink.preview, (event, url: unknown) => {
    requireMainWindowRenderer(event)
    return webLinkPreviews.get(url)
  })
}
