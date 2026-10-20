import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { readWorkspaceDiff } from '../agent/session/workspace-diffs'

export interface WorkspaceChangesIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
}

export function registerWorkspaceChangesIpc(options: WorkspaceChangesIpcOptions): void {
  const { ipcMain } = options
  ipcMain.handle(IPC.workspaceChanges.readDiff, async (_, ref: unknown) => readWorkspaceDiff(ref))
}
