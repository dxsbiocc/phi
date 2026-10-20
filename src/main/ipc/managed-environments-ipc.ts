import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { errorMessage } from '../../shared/errorCodes'
import type { EnvironmentBuilds } from '../agent/content/environment-builds'
import { createManagedEnvironmentActions, listManagedEnvironments } from '../agent/environment'
import { collectGarbage } from '../agent/envs/gc'
import { getRuntimeRoot } from '../agent/envs/runtime'
import { cleanupInactiveMcpVersions } from '../agent/packages/mcp-version-cleanup'

export interface ManagedEnvironmentsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  agentDir: string
  builds: EnvironmentBuilds
}

export function registerManagedEnvironmentsIpc(options: ManagedEnvironmentsIpcOptions): void {
  const { ipcMain, agentDir: AGENT_DIR, builds: environmentBuilds } = options
  const managedEnvironmentActions = createManagedEnvironmentActions({
    root: getRuntimeRoot(),
    agentDir: AGENT_DIR,
    builds: environmentBuilds,
    collect: (root, collectOptions) => {
      const result = collectGarbage(root, collectOptions)
      if (!collectOptions?.dryRun) cleanupInactiveMcpVersions(AGENT_DIR, root)
      return result
    },
    catalog: (projectDir, includeDynamic) =>
      listManagedEnvironments({
        ...(projectDir ? { projectDir } : {}),
        builds: environmentBuilds.list(),
        includeDynamic
      })
  })
  ipcMain.handle(
    IPC.managedEnvironments.list,
    async (_, projectCwd: unknown, includeDynamic: unknown) => {
      try {
        return await managedEnvironmentActions.list(projectCwd, includeDynamic)
      } catch (error) {
        throw new Error(`读取托管环境失败：${errorMessage(error)}`)
      }
    }
  )
  ipcMain.handle(
    IPC.managedEnvironments.build,
    async (_, ref: unknown, projectCwd: unknown, pluginId: unknown) => {
      try {
        return managedEnvironmentActions.build(ref, projectCwd, pluginId)
      } catch (error) {
        throw new Error(`启动环境构建失败：${errorMessage(error)}`)
      }
    }
  )
  ipcMain.handle(IPC.managedEnvironments.rebuild, async (_, envId: unknown) => {
    try {
      await managedEnvironmentActions.rebuild(envId)
    } catch (error) {
      throw new Error(`重新构建环境失败：${errorMessage(error)}`)
    }
  })
  ipcMain.handle(IPC.managedEnvironments.remove, async (_, envId: unknown) => {
    try {
      return await managedEnvironmentActions.remove(envId)
    } catch (error) {
      throw new Error(`删除环境失败：${errorMessage(error)}`)
    }
  })
  ipcMain.handle(IPC.managedEnvironments.clean, async () => {
    try {
      return await managedEnvironmentActions.clean()
    } catch (error) {
      throw new Error(`清理环境失败：${errorMessage(error)}`)
    }
  })
}
