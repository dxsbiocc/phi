import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { readAppSettings, updateAppSettings } from '../agent/app-settings'
import { getPhiEngine } from '../agent/engine/in-process-engine'

export interface SettingsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  agentDir: string
  syncPreventSleepBlocker: () => void
}

export function registerSettingsIpc(options: SettingsIpcOptions): void {
  const { ipcMain, agentDir: AGENT_DIR, syncPreventSleepBlocker } = options
  ipcMain.handle(IPC.settings.get, async () => readAppSettings())
  ipcMain.handle(IPC.settings.update, async (_, patch: unknown) => {
    const settings = updateAppSettings(patch)
    syncPreventSleepBlocker()
    return settings
  })
  ipcMain.handle(IPC.settings.webSearchGet, async () =>
    getPhiEngine().settings.webSearch.get({ agentDir: AGENT_DIR })
  )
  ipcMain.handle(IPC.settings.webSearchUpdate, async (_, patch: unknown) =>
    getPhiEngine().settings.webSearch.update({ agentDir: AGENT_DIR, patch })
  )
  ipcMain.handle(IPC.settings.webSearchSearxngEngines, async () =>
    getPhiEngine().settings.webSearch.searxngEngines({ agentDir: AGENT_DIR })
  )
  ipcMain.handle(IPC.settings.webSearchApiKeySet, async (_, providerId: unknown, key: unknown) =>
    getPhiEngine().settings.webSearch.setApiKey({
      agentDir: AGENT_DIR,
      providerId,
      key
    })
  )
  ipcMain.handle(IPC.settings.webSearchApiKeyClear, async (_, providerId: unknown) =>
    getPhiEngine().settings.webSearch.clearApiKey({ agentDir: AGENT_DIR, providerId })
  )
}
