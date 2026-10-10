import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { RemoteRuntimeRootWarningCode } from '../../shared/remoteRuntimeRootTypes'
import type { RemoteRipgrepProgress } from '../../shared/remoteRipgrepTypes'
import { runRemoteRipgrepForHost } from './remote-ripgrep-settings'

const WARNING_CODES = new Set<RemoteRuntimeRootWarningCode>([
  'not-owned',
  'group-or-other-writable',
  'symlink',
  'low-space',
  'high-disk-use',
  'noexec',
  'shared-filesystem-info'
])

interface RemoteRipgrepIpcRequest {
  action: 'status' | 'install'
  requestId: string
  hostProfileId: string
  runtimeRoot: string
  confirmedWarnings?: readonly RemoteRuntimeRootWarningCode[]
  forceManaged?: boolean
}

function safeString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/.test(value)
  )
}

function parseRequest(value: unknown): RemoteRipgrepIpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ripgrep 请求无效')
  }
  const input = value as Record<string, unknown>
  const warnings = input.confirmedWarnings
  if (
    (input.action !== 'status' && input.action !== 'install') ||
    !safeString(input.requestId, 128) ||
    !safeString(input.hostProfileId, 512) ||
    !safeString(input.runtimeRoot, 4096) ||
    (input.forceManaged !== undefined && typeof input.forceManaged !== 'boolean') ||
    (warnings !== undefined &&
      (!Array.isArray(warnings) || !warnings.every((code) => WARNING_CODES.has(code))))
  ) {
    throw new Error('ripgrep 请求无效')
  }
  return {
    action: input.action,
    requestId: input.requestId,
    hostProfileId: input.hostProfileId,
    runtimeRoot: input.runtimeRoot,
    ...(input.forceManaged === true ? { forceManaged: true } : {}),
    ...(warnings ? { confirmedWarnings: warnings as RemoteRuntimeRootWarningCode[] } : {})
  }
}

function sendProgress(
  event: IpcMainInvokeEvent,
  requestId: string,
  progress: RemoteRipgrepProgress
): void {
  if (!event.sender.isDestroyed()) {
    event.sender.send('remote:ripgrepProgress', { ...progress, requestId })
  }
}

export function registerRemoteRipgrepIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  run: typeof runRemoteRipgrepForHost = runRemoteRipgrepForHost
): void {
  ipcMain.handle('remote:ripgrep', async (event, value: unknown) => {
    const request = parseRequest(value)
    return run(request.hostProfileId, {
      action: request.action,
      runtimeRoot: request.runtimeRoot,
      confirmedWarnings: request.confirmedWarnings,
      forceManaged: request.forceManaged,
      onProgress: (progress) => sendProgress(event, request.requestId, progress)
    })
  })
}
