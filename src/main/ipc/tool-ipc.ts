import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import { IPC } from '../../shared/ipcChannels'

export interface ToolIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  resolveToolApproval: (requestId: string, approved: boolean, sender: WebContents) => boolean
  requireMainWindowRenderer: (event: IpcMainInvokeEvent) => BrowserWindow
  /** Shows a window everything still waiting for an answer, e.g. after it was closed and reopened. */
  showPendingRequests: (window: BrowserWindow) => void
}

export function registerToolIpc(options: ToolIpcOptions): void {
  const ipcMain = options.ipcMain
  const resolveToolApproval = options.resolveToolApproval

  ipcMain.handle(
    IPC.tool.approvalResponse,
    async (event, requestId: unknown, approved: unknown) => {
      if (
        typeof requestId !== 'string' ||
        requestId.length === 0 ||
        requestId.length > 256 ||
        typeof approved !== 'boolean'
      ) {
        return false
      }
      return resolveToolApproval(requestId, approved, event.sender)
    }
  )
  ipcMain.handle(IPC.tool.showPending, (event) => {
    options.showPendingRequests(options.requireMainWindowRenderer(event))
  })
}
