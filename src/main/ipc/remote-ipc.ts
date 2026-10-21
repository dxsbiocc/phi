import type { IpcMain } from 'electron'

import type { RemoteDoctorOptions } from '../../shared/remoteDoctorTypes'
import type {
  RemoteEnvironmentSettingInput,
  RemoteEnvironmentToolId
} from '../../shared/remoteEnvironmentTypes'
import { IPC } from '../../shared/ipcChannels'
import { remoteDoctor } from '../agent/remote-doctor'
import { listSshHostAvailability, saveSshHostAvailability } from '../agent/ssh-host-availability'
import type { SshHostAvailabilityRecord } from '../../shared/sshHostAvailability'
import { installRemoteNextflow } from '../agent/remote-nextflow-install'
import {
  saveRemoteEnvironmentSetting,
  saveRemoteMicromambaMirrorSetting,
  saveRemoteRuntimeRootSetting
} from '../agent/remote-runtime-root-settings'

export interface RemoteIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
}

// eslint-disable-next-line max-lines-per-function -- Preserves the contiguous remote settings handlers verbatim.
export function registerRemoteIpc(options: RemoteIpcOptions): void {
  const ipcMain = options.ipcMain

  /* eslint-disable complexity -- Existing remote-environment validation is preserved verbatim. */
  ipcMain.handle(IPC.remote.saveEnvironment, async (_, hostProfileId: unknown, value: unknown) => {
    if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
      throw new Error('SSH 服务器档案 ID 无效')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('远程环境配置无效')
    }
    const input = value as Record<string, unknown>
    if (
      input.runtimeRoot !== undefined &&
      input.runtimeRoot !== null &&
      typeof input.runtimeRoot !== 'string'
    ) {
      throw new Error('默认运行环境路径无效')
    }
    const toolPaths: Partial<Record<RemoteEnvironmentToolId, string>> = {}
    if (input.toolPaths !== undefined) {
      if (
        !input.toolPaths ||
        typeof input.toolPaths !== 'object' ||
        Array.isArray(input.toolPaths)
      ) {
        throw new Error('远程工具路径无效')
      }
      for (const id of ['nextflow', 'jupyter', 'micromamba', 'docker'] as const) {
        const path = (input.toolPaths as Record<string, unknown>)[id]
        if (path !== undefined && typeof path !== 'string') {
          throw new Error(`${id} 路径无效`)
        }
        if (typeof path === 'string') toolPaths[id] = path
      }
    }
    return saveRemoteEnvironmentSetting(hostProfileId, {
      ...(typeof input.runtimeRoot === 'string' ? { runtimeRoot: input.runtimeRoot } : {}),
      toolPaths
    } satisfies RemoteEnvironmentSettingInput)
  })
  ipcMain.handle(
    IPC.remote.saveRuntimeRoot,
    async (_, hostProfileId: unknown, runtimeRoot: unknown) => {
      if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
        throw new Error('SSH 服务器档案 ID 无效')
      }
      if (runtimeRoot !== undefined && runtimeRoot !== null && typeof runtimeRoot !== 'string') {
        throw new Error('远程运行时根目录无效')
      }
      return saveRemoteRuntimeRootSetting(hostProfileId, runtimeRoot)
    }
  )
  ipcMain.handle(
    IPC.remote.saveMicromambaMirror,
    async (_, hostProfileId: unknown, downloadMirrorPrefix: unknown) => {
      if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
        throw new Error('SSH 服务器档案 ID 无效')
      }
      if (
        downloadMirrorPrefix !== undefined &&
        downloadMirrorPrefix !== null &&
        typeof downloadMirrorPrefix !== 'string'
      ) {
        throw new Error('下载镜像前缀无效')
      }
      return saveRemoteMicromambaMirrorSetting(hostProfileId, downloadMirrorPrefix)
    }
  )
  ipcMain.handle(
    IPC.remote.doctor,
    async (_, hostProfileId: unknown, remotePath: unknown, options: unknown) => {
      if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
        throw new Error('SSH 服务器档案 ID 无效')
      }
      if (remotePath !== undefined && typeof remotePath !== 'string') {
        throw new Error('远程目录路径无效')
      }
      const raw =
        options && typeof options === 'object' && !Array.isArray(options)
          ? (options as Record<string, unknown>)
          : {}
      return remoteDoctor(hostProfileId, remotePath, options as RemoteDoctorOptions, {
        userInitiated: raw.userInitiated !== false
      })
    }
  )
  ipcMain.handle(IPC.remote.listHostAvailability, () => listSshHostAvailability())
  ipcMain.handle(IPC.remote.saveHostAvailability, (_, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('SSH 服务器可用状态无效')
    }
    return saveSshHostAvailability(value as SshHostAvailabilityRecord)
  })
  ipcMain.handle(IPC.remote.installNextflow, async (_, hostProfileId: unknown) => {
    if (typeof hostProfileId !== 'string' || !hostProfileId.trim()) {
      throw new Error('SSH 服务器档案 ID 无效')
    }
    return installRemoteNextflow(hostProfileId)
  })
  /* eslint-enable complexity */
}
