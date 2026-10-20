// Owns Phi Plugin IPC registration and request orchestration.
// Receives only the lifecycle, workspace, window, and plugin collaborators it uses.
import semver from 'semver'

import { dialog, type BrowserWindow, type IpcMain } from 'electron'

import { errorMessage } from '../../shared/errorCodes'
import { IPC } from '../../shared/ipcChannels'
import type { PhiPluginInstallPreview } from '../../shared/phiPluginTypes'
import { readAppSettings } from '../agent/app-settings'
import type { EnvironmentBuilds } from '../agent/content/environment-builds'
import { getRuntimeRoot } from '../agent/envs/runtime'
import { createPhiPluginManagementView } from '../agent/plugins/phi-plugin-management-view'
import {
  installPlugin as installPhiPlugin,
  listInstalledPlugins,
  setPluginEnabled,
  uninstallPlugin as uninstallPhiPlugin,
  upgradePlugin,
  type PluginLifecycleResult,
  type PluginNamespace
} from '../agent/plugins/loader'
import { validatePlugin } from '../agent/plugins/validate'
import { nativeUiCopy } from '../native-ui-copy'

export interface PhiPluginIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  lifecycle: {
    invalidateAgentSession: () => Promise<void>
    logUnexpectedError: (error: unknown) => void
  }
  workspace: {
    agentDir: string
  }
  plugins: {
    installedPluginNamespace: (projectDir?: string) => Promise<PluginNamespace>
    environmentBuilds: Pick<EnvironmentBuilds, 'start'>
  }
  windows: {
    getActiveWindow: () => BrowserWindow | null
  }
}

type PhiPluginIpcContext = ReturnType<typeof createPhiPluginIpcContext>

function createPhiPluginIpcContext(options: PhiPluginIpcOptions): {
  options: PhiPluginIpcOptions
  AGENT_DIR: string
  view: ReturnType<typeof createPhiPluginManagementView>
} {
  const AGENT_DIR = options.workspace.agentDir
  return {
    options,
    AGENT_DIR,
    view: createPhiPluginManagementView(AGENT_DIR)
  }
}

export function registerPhiPluginIpc(options: PhiPluginIpcOptions): void {
  const context = createPhiPluginIpcContext(options)
  registerPhiPluginBrowseIpc(context)
  registerPhiPluginInstallIpc(context)
  registerPhiPluginStateIpc(context)
}

function registerPhiPluginBrowseIpc(context: PhiPluginIpcContext): void {
  const ipcMain = context.options.ipcMain
  const getActiveWindow = context.options.windows.getActiveWindow
  const logUnexpectedError = context.options.lifecycle.logUnexpectedError
  const phiPluginListItems = context.view.listItems
  const phiPluginProblemView = context.view.problem
  const phiPluginInstallPreview = context.view.installPreview
  ipcMain.handle(IPC.phiPlugins.list, async () => phiPluginListItems())
  ipcMain.handle(IPC.phiPlugins.pickDirectory, async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectPlugin,
      buttonLabel: dialogCopy.select,
      properties: ['openDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.phiPlugins.previewDirectory, async (_, path: unknown) => {
    if (typeof path !== 'string' || path.trim().length === 0) {
      return {
        ok: false,
        path: '',
        problems: [
          phiPluginProblemView({
            level: 'error',
            path: 'path',
            message: 'Select a valid Plugin directory'
          })
        ]
      } satisfies PhiPluginInstallPreview
    }
    try {
      return phiPluginInstallPreview(path)
    } catch (error) {
      logUnexpectedError(error)
      return {
        ok: false,
        path,
        problems: [
          phiPluginProblemView({
            level: 'error',
            path: 'preview',
            message: `Plugin validation failed: ${errorMessage(error)}`
          })
        ]
      } satisfies PhiPluginInstallPreview
    }
  })
}

function registerPhiPluginInstallIpc(context: PhiPluginIpcContext): void {
  const { options, AGENT_DIR, view } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const logUnexpectedError = options.lifecycle.logUnexpectedError
  const installedPluginNamespace = options.plugins.installedPluginNamespace
  const environmentBuilds = options.plugins.environmentBuilds
  const phiPluginMutation = view.mutation
  const failedPhiPluginMutation = view.failedMutation
  ipcMain.handle(IPC.phiPlugins.installFromDirectory, async (_, path: unknown) => {
    if (typeof path !== 'string' || path.trim().length === 0) {
      return failedPhiPluginMutation('path', 'Select a valid Plugin directory')
    }
    try {
      const validation = validatePlugin(path)
      if (!validation.ok || !validation.plugin) {
        return phiPluginMutation({
          ok: false,
          errors: validation.errors,
          warnings: validation.warnings
        })
      }
      const existing = listInstalledPlugins({ agentDir: AGENT_DIR }).find(
        (plugin) => plugin.id === validation.plugin?.manifest.id
      )
      const names = await installedPluginNamespace()
      let result: PluginLifecycleResult
      if (!existing) {
        result = installPhiPlugin(path, {
          agentDir: AGENT_DIR,
          runtimeRoot: getRuntimeRoot(),
          names,
          source: 'local'
        })
      } else if (semver.gt(validation.plugin.manifest.version, existing.version)) {
        result = await upgradePlugin(path, {
          agentDir: AGENT_DIR,
          runtimeRoot: getRuntimeRoot(),
          names,
          source: 'local',
          build: (descriptor, options) => environmentBuilds.start(descriptor, options)
        })
      } else {
        return failedPhiPluginMutation(
          'version',
          `${existing.id} ${existing.version} is already installed. Select a newer version to upgrade.`
        )
      }
      if (result.ok) await invalidateAgentSession()
      return phiPluginMutation(result)
    } catch (error) {
      logUnexpectedError(error)
      return failedPhiPluginMutation(
        'install',
        `Plugin installation failed: ${errorMessage(error)}`
      )
    }
  })
}

function registerPhiPluginStateIpc(context: PhiPluginIpcContext): void {
  const { options, AGENT_DIR, view } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const logUnexpectedError = options.lifecycle.logUnexpectedError
  const installedPluginNamespace = options.plugins.installedPluginNamespace
  const phiPluginMutation = view.mutation
  const failedPhiPluginMutation = view.failedMutation
  ipcMain.handle(IPC.phiPlugins.setEnabled, async (_, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || id.length === 0 || typeof enabled !== 'boolean') {
      return failedPhiPluginMutation('request', 'Invalid Plugin ID or enabled state')
    }
    try {
      const result = setPluginEnabled(id, enabled, {
        agentDir: AGENT_DIR,
        names: await installedPluginNamespace()
      })
      return phiPluginMutation(result)
    } catch (error) {
      logUnexpectedError(error)
      return failedPhiPluginMutation(
        'enabled',
        `Could not update Plugin state: ${errorMessage(error)}`
      )
    }
  })
  ipcMain.handle(IPC.phiPlugins.uninstall, async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      return failedPhiPluginMutation('id', 'Invalid Plugin ID')
    }
    try {
      const result = uninstallPhiPlugin(id, {
        agentDir: AGENT_DIR,
        runtimeRoot: getRuntimeRoot()
      })
      if (result.ok) await invalidateAgentSession()
      return phiPluginMutation(result)
    } catch (error) {
      logUnexpectedError(error)
      return failedPhiPluginMutation(
        'uninstall',
        `Could not uninstall Plugin: ${errorMessage(error)}`
      )
    }
  })
}
