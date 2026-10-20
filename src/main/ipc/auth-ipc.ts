import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { getAuthManager } from '../agent/auth-manager'

export interface AuthIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  invalidateAgentSession: () => Promise<void>
}

export function registerAuthIpc(options: AuthIpcOptions): void {
  const { ipcMain, invalidateAgentSession } = options
  ipcMain.handle(IPC.auth.status, async () => getAuthManager().getProviderStatuses())
  ipcMain.handle(IPC.auth.loginApiKey, async (_, providerId: string, key: string) => {
    const normalizedKey = key.trim()
    const status = await getAuthManager().loginApiKey(providerId, normalizedKey)
    await invalidateAgentSession()
    return status
  })
  ipcMain.handle(IPC.auth.loginOAuth, async (_, providerId: string) => {
    const status = await getAuthManager().loginOAuth(providerId)
    await invalidateAgentSession()
    return status
  })
  ipcMain.handle(IPC.auth.logout, async (_, providerId: string) => {
    await getAuthManager().logout(providerId)
    await invalidateAgentSession()
  })
  ipcMain.handle(IPC.auth.interactionResponse, async (_, requestId: string, value: string) => {
    await getAuthManager().resolveInteraction(requestId, value)
  })
}
