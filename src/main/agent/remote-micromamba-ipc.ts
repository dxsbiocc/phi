import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { RemoteRuntimeRootWarningCode } from '../../shared/remoteRuntimeRootTypes'
import { normalizeRemoteMicromambaMirrorPrefix } from '../../shared/remoteMicromambaTypes'
import { installRemoteMicromambaForHost } from './remote-micromamba-settings'

const WARNING_CODES = new Set<RemoteRuntimeRootWarningCode>([
  'not-owned',
  'group-or-other-writable',
  'symlink',
  'low-space',
  'high-disk-use',
  'noexec',
  'shared-filesystem-info'
])

interface RemoteMicromambaIpcRequest {
  requestId: string
  hostProfileId: string
  runtimeRoot: string
  downloadMirrorPrefix?: string
  confirmedWarnings?: readonly RemoteRuntimeRootWarningCode[]
}

function nonEmptySafeString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/.test(value)
  )
}

function parseRequest(value: unknown): RemoteMicromambaIpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('micromamba 安装请求无效')
  }
  const input = value as Record<string, unknown>
  if (
    !nonEmptySafeString(input.requestId, 128) ||
    !nonEmptySafeString(input.hostProfileId, 512) ||
    !nonEmptySafeString(input.runtimeRoot, 4096)
  ) {
    throw new Error('micromamba 安装请求无效')
  }
  const warnings = input.confirmedWarnings
  if (
    warnings !== undefined &&
    (!Array.isArray(warnings) || !warnings.every((code) => WARNING_CODES.has(code)))
  ) {
    throw new Error('micromamba 警告确认值无效')
  }
  if (input.downloadMirrorPrefix !== undefined && typeof input.downloadMirrorPrefix !== 'string') {
    throw new Error('下载镜像前缀无效')
  }
  const downloadMirrorPrefix = normalizeRemoteMicromambaMirrorPrefix(
    (input.downloadMirrorPrefix as string | undefined) ?? ''
  )
  return {
    requestId: input.requestId,
    hostProfileId: input.hostProfileId,
    runtimeRoot: input.runtimeRoot,
    ...(downloadMirrorPrefix ? { downloadMirrorPrefix } : {}),
    ...(warnings ? { confirmedWarnings: warnings as RemoteRuntimeRootWarningCode[] } : {})
  }
}

function sendProgress(
  event: IpcMainInvokeEvent,
  requestId: string,
  progress: Parameters<
    NonNullable<Parameters<typeof installRemoteMicromambaForHost>[1]['onProgress']>
  >[0]
): void {
  if (!event.sender.isDestroyed()) {
    event.sender.send('remote:micromambaProgress', { requestId, ...progress })
  }
}

export function registerRemoteMicromambaIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  install: typeof installRemoteMicromambaForHost = installRemoteMicromambaForHost
): void {
  ipcMain.handle('remote:micromamba', async (event, value: unknown) => {
    const request = parseRequest(value)
    return install(request.hostProfileId, {
      runtimeRoot: request.runtimeRoot,
      downloadMirrorPrefix: request.downloadMirrorPrefix,
      confirmedWarnings: request.confirmedWarnings,
      onProgress: (progress) => sendProgress(event, request.requestId, progress)
    })
  })
}
