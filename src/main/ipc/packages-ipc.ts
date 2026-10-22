// Owns registration and request orchestration for installable content packages.
// Receives application lifecycle, window, plugin namespace, and shared catalog collaborators.
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import { errorMessage } from '../../shared/errorCodes'
import { IPC } from '../../shared/ipcChannels'
import { readAppSettings } from '../agent/app-settings'
import { writeAppLog } from '../agent/app-logger'
import type { EnvironmentBuilds } from '../agent/content/environment-builds'
import { getRuntimeRoot } from '../agent/envs/runtime'
import { setMcpPackageEnabled } from '../agent/mcp-connectors'
import { setEnabled } from '../agent/enablement'
import {
  applyPackageUpdate,
  applyPackageUpdates,
  importOfflinePackage,
  installPackages as installRegistryPackages,
  listKnownRegistries,
  listInstalledPackages as listRegistryPackages,
  listPackageUpdates,
  loadKnownRegistryIndexes,
  planInstall as planRegistryInstall,
  previewOfflinePackageImport,
  removeKnownRegistry,
  type PackageUpdate,
  uninstallPackage as uninstallRegistryPackage
} from '../agent/packages/installer'
import { prepareContentPackageInstall, readContentRegistry } from '../agent/packages/content-source'
import { packageRegistryIconView } from '../agent/packages/icon-views'
import type { InstallerOptions } from '../agent/packages/installer-types'
import type { PackageType } from '../agent/packages/manifest'
import { runPackageMutation } from '../agent/packages/mutation-queue'
import { previewWrapperRemoval, removeWrapperPackage } from '../agent/packages/wrapper-removal'
import { readSkillPackageDetail } from '../agent/packages/skill-detail'
import { syncPreferredOfficialRegistry } from '../agent/packages/official-website-registry'
import { readWrapperPackageDetail } from '../agent/packages/wrapper-detail'
import type { PluginNamespace } from '../agent/plugins/loader'
import { readResourceIcon } from '../agent/resource-icons'
import { resetWrapperCompositionCatalogCache } from '../agent/wrappers/composition/discovery'
import { nativeUiCopy } from '../native-ui-copy'

type OfficialContentSourceOptions = InstallerOptions & {
  agentDir: string
  appVersion: string
  fetch: typeof fetch
  buildMcpEnvironment: NonNullable<InstallerOptions['buildMcpEnvironment']>
  verifyMcpStdio: NonNullable<InstallerOptions['verifyMcpStdio']>
}

export interface PackagesIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  lifecycle: {
    getAppVersion: () => string
    invalidateAgentSession: () => Promise<void>
  }
  workspace: {
    agentDir: string
  }
  windows: {
    getActiveWindow: () => BrowserWindow | null
  }
  plugins: {
    installedPluginNamespace: (projectDir?: string) => Promise<PluginNamespace>
    environmentBuilds: Pick<EnvironmentBuilds, 'start'>
  }
  packages: {
    officialContentSourceOptions: () => OfficialContentSourceOptions
    knownContentSourceOptions: (
      type?: PackageType,
      forceRefresh?: boolean
    ) => Parameters<typeof listKnownRegistries>[0]
    loadPackageRegistries: (
      type?: PackageType,
      forceRefresh?: boolean
    ) => ReturnType<typeof loadKnownRegistryIndexes>
  }
  updates: {
    refreshCachedPackageUpdates: () => Promise<PackageUpdate[]>
    packageUpdateViews: (updates: readonly PackageUpdate[]) => PackageUpdate[]
    replaceCachedPackageUpdates: (updates: PackageUpdate[]) => void
  }
}

export function registerResourceCatalogIpc(ipcMain: Pick<IpcMain, 'handle'>): void {
  ipcMain.handle(IPC.resources.readIcon, (_, key: unknown) => readResourceIcon(key))
}

/** Package changes share registries on disk, so they run one after another (see mutation-queue). */
function serializedPackageMutation<Args extends unknown[], Result>(
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result>
): (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> {
  return (event, ...args) => runPackageMutation(() => handler(event, ...args))
}

function createPackagesIpcContext(options: PackagesIpcOptions): {
  options: PackagesIpcOptions
  app: { getVersion: () => string }
} {
  return {
    options,
    app: { getVersion: options.lifecycle.getAppVersion }
  }
}

type PackagesIpcContext = ReturnType<typeof createPackagesIpcContext>

export function registerPackageOperationsIpc(options: PackagesIpcOptions): void {
  const context = createPackagesIpcContext(options)
  registerPackageDetailsIpc(context)
  registerPackageInstallIpc(context)
  registerPackageRemovalIpc(context)
  registerOfflinePackageIpc(context)
  registerPackageUpdateIpc(context)
  registerAllPackageUpdatesIpc(context)
}

export function registerPackageCatalogIpc(registrationOptions: PackagesIpcOptions): void {
  const context = createPackagesIpcContext(registrationOptions)
  const { options } = context
  const ipcMain = options.ipcMain
  const AGENT_DIR = options.workspace.agentDir
  const getActiveWindow = options.windows.getActiveWindow
  const officialContentSourceOptions = options.packages.officialContentSourceOptions
  const knownContentSourceOptions = options.packages.knownContentSourceOptions
  ipcMain.handle(IPC.packages.pickRegistryDirectory, async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectSkill,
      buttonLabel: dialogCopy.select,
      properties: ['openDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.packages.pickArchive, async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.importPackage,
      buttonLabel: dialogCopy.import,
      properties: ['openFile'],
      filters: [{ name: dialogCopy.packageFilter, extensions: ['tar.gz'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.packages.listRegistries, async () => {
    const result = await listKnownRegistries(knownContentSourceOptions())
    if (result.error) {
      writeAppLog({
        level: 'warn',
        event: 'package_registries_invalid',
        metadata: { error: result.error }
      })
    }
    return result.registries
  })
  ipcMain.handle(IPC.packages.contentCatalog, async (_, forceRefresh?: unknown) => {
    if (forceRefresh !== undefined && typeof forceRefresh !== 'boolean')
      throw new Error('Invalid catalog refresh request')
    const registry = await syncPreferredOfficialRegistry({
      ...officialContentSourceOptions(),
      forceRefresh: forceRefresh === true
    })
    return packageRegistryIconView(registry)
  })
  ipcMain.handle(IPC.packages.removeRegistry, async (_, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid source ID')
    removeKnownRegistry(id, { agentDir: AGENT_DIR })
    return (await listKnownRegistries(knownContentSourceOptions())).registries
  })
}

function registerPackageDetailsIpc(context: PackagesIpcContext): void {
  const { options, app } = context
  const ipcMain = options.ipcMain
  const AGENT_DIR = options.workspace.agentDir
  const officialContentSourceOptions = options.packages.officialContentSourceOptions
  ipcMain.handle(IPC.packages.registry, async (_, dir: unknown) => {
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      throw new Error('Invalid registry directory')
    }
    try {
      const registry = await readContentRegistry(dir, officialContentSourceOptions())
      return packageRegistryIconView(registry)
    } catch (error) {
      throw new Error(`Could not read package registry: ${errorMessage(error)}`)
    }
  })
  ipcMain.handle(
    IPC.packages.plan,
    async (_, dir: unknown, type: unknown, id: unknown, version?: unknown) => {
      if (
        typeof dir !== 'string' ||
        (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
        typeof id !== 'string' ||
        id.length === 0 ||
        (version !== undefined && typeof version !== 'string')
      ) {
        throw new Error('Invalid package installation plan request')
      }
      try {
        const registry = await readContentRegistry(dir, officialContentSourceOptions())
        return planRegistryInstall(
          registry,
          { type, id, ...(version ? { version } : {}) },
          { agentDir: AGENT_DIR, appVersion: app.getVersion() }
        )
      } catch (error) {
        throw new Error(`Could not create package installation plan: ${errorMessage(error)}`)
      }
    }
  )
  ipcMain.handle(IPC.packages.skillDetail, async (_, dir: unknown, id: unknown) => {
    if (typeof dir !== 'string' || typeof id !== 'string' || id.length === 0) {
      throw new Error('Invalid Skill package detail request')
    }
    try {
      const registry = await readContentRegistry(dir, officialContentSourceOptions())
      return await readSkillPackageDetail(registry, id, officialContentSourceOptions())
    } catch (error) {
      throw new Error(`Could not read Skill package details: ${errorMessage(error)}`)
    }
  })
  ipcMain.handle(IPC.packages.wrapperDetail, async (_, dir: unknown, id: unknown) => {
    if (typeof dir !== 'string' || typeof id !== 'string' || id.length === 0) {
      throw new Error('Invalid Wrapper package detail request')
    }
    try {
      const registry = await readContentRegistry(dir, officialContentSourceOptions())
      return await readWrapperPackageDetail(registry, id, officialContentSourceOptions())
    } catch (error) {
      throw new Error(`Could not read Wrapper package details: ${errorMessage(error)}`)
    }
  })
}

function registerPackageInstallIpc(context: PackagesIpcContext): void {
  const { options, app } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const AGENT_DIR = options.workspace.agentDir
  const environmentBuilds = options.plugins.environmentBuilds
  const installedPluginNamespace = options.plugins.installedPluginNamespace
  const officialContentSourceOptions = options.packages.officialContentSourceOptions
  ipcMain.handle(
    IPC.packages.install,
    serializedPackageMutation(
      // eslint-disable-next-line complexity -- This handler's existing validation and install flow is preserved verbatim.
      async (_, dir: unknown, type: unknown, id: unknown, version?: unknown) => {
        if (
          typeof dir !== 'string' ||
          (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
          typeof id !== 'string' ||
          id.length === 0 ||
          (version !== undefined && typeof version !== 'string')
        ) {
          throw new Error('Invalid package installation request')
        }
        try {
          const registry = await readContentRegistry(dir, officialContentSourceOptions())
          const installedBefore = new Set(
            listRegistryPackages({ agentDir: AGENT_DIR }).map((item) => `${item.type}:${item.id}`)
          )
          await prepareContentPackageInstall(
            registry,
            { type, id, ...(version ? { version } : {}) },
            officialContentSourceOptions()
          )
          const plan = planRegistryInstall(
            registry,
            { type, id, ...(version ? { version } : {}) },
            { agentDir: AGENT_DIR, appVersion: app.getVersion() }
          )
          const result = await installRegistryPackages(plan, {
            agentDir: AGENT_DIR,
            runtimeRoot: getRuntimeRoot(),
            names: await installedPluginNamespace(),
            build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
          })
          for (const installed of result) {
            if (
              installed.type === 'skill' &&
              !installedBefore.has(`${installed.type}:${installed.id}`)
            ) {
              setEnabled(`skill:${installed.id}`, true, { agentDir: AGENT_DIR })
            }
            if (
              installed.type === 'mcp' &&
              !installedBefore.has(`${installed.type}:${installed.id}`)
            ) {
              setEnabled(`mcp:${installed.id}`, true, { agentDir: AGENT_DIR })
              setMcpPackageEnabled(installed.id, true, AGENT_DIR)
            }
          }
          if (result.some((installed) => installed.type === 'wrapper')) {
            resetWrapperCompositionCatalogCache()
          }
          await invalidateAgentSession()
          return result
        } catch (error) {
          throw new Error(`Package installation failed: ${errorMessage(error)}`)
        }
      }
    )
  )
}

function registerPackageRemovalIpc(context: PackagesIpcContext): void {
  const { options } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const AGENT_DIR = options.workspace.agentDir
  ipcMain.handle(IPC.packages.previewWrapperRemoval, async (_, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0)
      throw new Error('Invalid Wrapper package request')
    try {
      return previewWrapperRemoval(id, { agentDir: AGENT_DIR })
    } catch (error) {
      throw new Error(errorMessage(error))
    }
  })
  ipcMain.handle(
    IPC.packages.removeWrapper,
    serializedPackageMutation(async (_, id: unknown, request: unknown) => {
      if (typeof id !== 'string' || id.length === 0)
        throw new Error('Invalid Wrapper package request')
      const disableDependents =
        typeof request === 'object' &&
        request !== null &&
        (request as { disableDependents?: unknown }).disableDependents === true
      try {
        const result = removeWrapperPackage(id, {
          agentDir: AGENT_DIR,
          ...(disableDependents ? { disableDependents } : {})
        })
        resetWrapperCompositionCatalogCache()
        await invalidateAgentSession()
        return result
      } catch (error) {
        throw new Error(errorMessage(error))
      }
    })
  )
  ipcMain.handle(
    IPC.packages.uninstall,
    serializedPackageMutation(async (_, type: unknown, id: unknown) => {
      if (
        (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
        typeof id !== 'string' ||
        id.length === 0
      ) {
        throw new Error('Invalid package uninstall request')
      }
      try {
        const result = uninstallRegistryPackage(type, id, {
          agentDir: AGENT_DIR,
          runtimeRoot: getRuntimeRoot()
        })
        if (type === 'wrapper') resetWrapperCompositionCatalogCache()
        if (type === 'mcp') setEnabled(`mcp:${id}`, null, { agentDir: AGENT_DIR })
        await invalidateAgentSession()
        return result
      } catch (error) {
        throw new Error(`Could not uninstall package: ${errorMessage(error)}`)
      }
    })
  )
  ipcMain.handle(IPC.packages.listInstalled, async () => {
    try {
      return listRegistryPackages({ agentDir: AGENT_DIR })
    } catch (error) {
      throw new Error(`Could not read installed packages: ${errorMessage(error)}`)
    }
  })
}

function registerOfflinePackageIpc(context: PackagesIpcContext): void {
  const { options, app } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const AGENT_DIR = options.workspace.agentDir
  const environmentBuilds = options.plugins.environmentBuilds
  const installedPluginNamespace = options.plugins.installedPluginNamespace
  const officialContentSourceOptions = options.packages.officialContentSourceOptions
  const loadPackageRegistries = options.packages.loadPackageRegistries
  ipcMain.handle(IPC.packages.previewImport, async (_, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0)
      throw new Error('Invalid offline package path')
    try {
      return previewOfflinePackageImport(path, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion(),
        registries: (await loadPackageRegistries()).registries
      })
    } catch (error) {
      throw new Error(`Could not read offline package: ${errorMessage(error)}`)
    }
  })
  ipcMain.handle(
    IPC.packages.import,
    serializedPackageMutation(async (_, path: unknown) => {
      if (typeof path !== 'string' || path.length === 0)
        throw new Error('Invalid offline package path')
      const installedBefore = new Set(
        listRegistryPackages({ agentDir: AGENT_DIR }).map((item) => `${item.type}:${item.id}`)
      )
      try {
        const result = await importOfflinePackage(path, {
          agentDir: AGENT_DIR,
          appVersion: app.getVersion(),
          runtimeRoot: getRuntimeRoot(),
          registries: (await loadPackageRegistries()).registries,
          preparePackage: async (registry, entry) => {
            await prepareContentPackageInstall(
              registry,
              { type: entry.type, id: entry.id, version: entry.version },
              officialContentSourceOptions()
            )
          },
          names: await installedPluginNamespace(),
          build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
        })
        for (const installed of result) {
          if (
            !installedBefore.has(`${installed.type}:${installed.id}`) &&
            installed.type === 'skill'
          ) {
            setEnabled(`skill:${installed.id}`, true, { agentDir: AGENT_DIR })
          }
          if (
            !installedBefore.has(`${installed.type}:${installed.id}`) &&
            installed.type === 'mcp'
          ) {
            setEnabled(`mcp:${installed.id}`, true, { agentDir: AGENT_DIR })
            setMcpPackageEnabled(installed.id, true, AGENT_DIR)
          }
        }
        if (result.some((installed) => installed.type === 'wrapper')) {
          resetWrapperCompositionCatalogCache()
        }
        await invalidateAgentSession()
        return result
      } catch (error) {
        throw new Error(`Could not import package: ${errorMessage(error)}`)
      }
    })
  )
}

function registerPackageUpdateIpc(context: PackagesIpcContext): void {
  const { options, app } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const AGENT_DIR = options.workspace.agentDir
  const environmentBuilds = options.plugins.environmentBuilds
  const installedPluginNamespace = options.plugins.installedPluginNamespace
  const officialContentSourceOptions = options.packages.officialContentSourceOptions
  const loadPackageRegistries = options.packages.loadPackageRegistries
  const refreshCachedPackageUpdates = options.updates.refreshCachedPackageUpdates
  const packageUpdateViews = options.updates.packageUpdateViews
  const replaceCachedPackageUpdates = options.updates.replaceCachedPackageUpdates
  ipcMain.handle(IPC.packages.listUpdates, async () =>
    packageUpdateViews(await refreshCachedPackageUpdates())
  )
  ipcMain.handle(
    IPC.packages.applyUpdate,
    serializedPackageMutation(async (_, type: unknown, id: unknown) => {
      if (
        (type !== 'skill' && type !== 'plugin' && type !== 'wrapper' && type !== 'mcp') ||
        typeof id !== 'string' ||
        id.length === 0
      ) {
        throw new Error('Invalid package update request')
      }
      const loaded = await loadPackageRegistries()
      const updates = listPackageUpdates(loaded.registries, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion()
      })
      const update = updates.find((candidate) => candidate.type === type && candidate.id === id)
      if (!update) throw new Error(`No update available: ${type}:${id}`)
      const result = await applyPackageUpdate(update, loaded.registries, {
        preparePackage: async (registry, request) => {
          await prepareContentPackageInstall(registry, request, officialContentSourceOptions())
        },
        agentDir: AGENT_DIR,
        appVersion: app.getVersion(),
        runtimeRoot: getRuntimeRoot(),
        names: await installedPluginNamespace(),
        build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
      })
      if (type === 'wrapper') resetWrapperCompositionCatalogCache()
      replaceCachedPackageUpdates(
        listPackageUpdates(loaded.registries, {
          agentDir: AGENT_DIR,
          appVersion: app.getVersion()
        })
      )
      await invalidateAgentSession()
      return result
    })
  )
}

function registerAllPackageUpdatesIpc(context: PackagesIpcContext): void {
  const { options, app } = context
  const ipcMain = options.ipcMain
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const AGENT_DIR = options.workspace.agentDir
  const environmentBuilds = options.plugins.environmentBuilds
  const installedPluginNamespace = options.plugins.installedPluginNamespace
  const officialContentSourceOptions = options.packages.officialContentSourceOptions
  const loadPackageRegistries = options.packages.loadPackageRegistries
  const replaceCachedPackageUpdates = options.updates.replaceCachedPackageUpdates
  ipcMain.handle(
    IPC.packages.applyAllUpdates,
    serializedPackageMutation(async () => {
      const loaded = await loadPackageRegistries()
      const updates = listPackageUpdates(loaded.registries, {
        agentDir: AGENT_DIR,
        appVersion: app.getVersion()
      })
      const result = await applyPackageUpdates(updates, loaded.registries, {
        preparePackage: async (registry, request) => {
          await prepareContentPackageInstall(registry, request, officialContentSourceOptions())
        },
        agentDir: AGENT_DIR,
        appVersion: app.getVersion(),
        runtimeRoot: getRuntimeRoot(),
        names: await installedPluginNamespace(),
        build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
      })
      if (updates.some((update) => update.type === 'wrapper')) {
        resetWrapperCompositionCatalogCache()
      }
      replaceCachedPackageUpdates(
        listPackageUpdates(loaded.registries, {
          agentDir: AGENT_DIR,
          appVersion: app.getVersion()
        })
      )
      await invalidateAgentSession()
      return result
    })
  )
}
