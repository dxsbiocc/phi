import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import {
  listRemoteWorkspaceDirectory,
  previewRemoteWorkspaceFile
} from '../agent/remote-workspace-file-ui'
import type { RemoteSshSession } from '../agent/wrappers/remote-ssh-session'

export interface RemoteWorkspaceIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  remote: {
    observe: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>
    requestProjectId: (request: unknown) => string
    connectWorkspaceHost: (request: {
      sessionId: string
      projectId: string
      execTimeoutMs: number
    }) => Promise<RemoteSshSession>
  }
}

export function registerRemoteWorkspaceIpc(options: RemoteWorkspaceIpcOptions): void {
  const ipcMain = options.ipcMain
  const remoteConnectionTracker = { observe: options.remote.observe }
  const remoteRequestProjectId = options.remote.requestProjectId
  const connectRemoteWorkspaceHost = options.remote.connectWorkspaceHost

  ipcMain.handle(IPC.remoteWorkspace.statPaths, async (_, request: unknown) =>
    remoteConnectionTracker.observe(remoteRequestProjectId(request), async () =>
      (await import('../agent/workspace-host/remote-registry')).remoteWorkspaceHosts.statPaths(
        request
      )
    )
  )
  ipcMain.handle(IPC.remoteWorkspace.preview, async (_, request: unknown) =>
    remoteConnectionTracker.observe(remoteRequestProjectId(request), () =>
      previewRemoteWorkspaceFile(request, { connectHost: connectRemoteWorkspaceHost })
    )
  )
  ipcMain.handle(IPC.remoteWorkspace.listDirectory, async (_, request: unknown) =>
    remoteConnectionTracker.observe(remoteRequestProjectId(request), () =>
      listRemoteWorkspaceDirectory(request)
    )
  )
}
