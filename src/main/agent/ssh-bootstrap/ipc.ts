import type { SshBootstrapTarget } from '../../../shared/sshBootstrapTypes'
import type { SshBootstrapCoordinator } from './coordinator'
import { validateSshBootstrapTarget } from './preflight'

interface RendererLike {
  mainFrame: unknown
  isDestroyed(): boolean
}

interface SshBootstrapIpcEvent {
  sender: RendererLike
  senderFrame: unknown
}

interface IpcMainLike {
  handle(
    channel: string,
    handler: (event: SshBootstrapIpcEvent, ...args: unknown[]) => Promise<unknown>
  ): void
}

function assertTrustedRenderer(
  event: SshBootstrapIpcEvent,
  getTrustedRenderer: () => RendererLike | null
): void {
  const trusted = getTrustedRenderer()
  if (
    !trusted ||
    trusted.isDestroyed() ||
    event.sender !== trusted ||
    event.sender.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Window renderer is not authorized')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)
}

function validSecret(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4_096 &&
    !/[\0\r\n]/.test(value)
  )
}

function parsedTarget(value: unknown): SshBootstrapTarget | null {
  if (!isRecord(value)) return null
  if (
    typeof value.alias !== 'string' ||
    typeof value.hostname !== 'string' ||
    typeof value.user !== 'string' ||
    typeof value.port !== 'number'
  ) {
    return null
  }
  try {
    return validateSshBootstrapTarget({
      alias: value.alias,
      hostname: value.hostname,
      user: value.user,
      port: value.port
    })
  } catch {
    return null
  }
}

function parsedPassword(value: unknown): { password: string } | null {
  return isRecord(value) && validSecret(value.password) ? { password: value.password } : null
}

function parsedKeyProtection(
  value: unknown
):
  | { keyProtection: 'passphrase'; passphrase: string }
  | { keyProtection: 'passwordless-explicit' }
  | null {
  if (!isRecord(value)) return null
  if (value.keyProtection === 'passwordless-explicit') {
    return { keyProtection: 'passwordless-explicit' }
  }
  if (value.keyProtection === 'passphrase' && validSecret(value.passphrase)) {
    return { keyProtection: 'passphrase', passphrase: value.passphrase }
  }
  return null
}

function clearCredentialValue(value: unknown): void {
  if (!isRecord(value)) return
  if (typeof value.password === 'string') value.password = ''
  if (typeof value.passphrase === 'string') value.passphrase = ''
}

export function registerSshBootstrapIpc(
  ipcMain: IpcMainLike,
  getTrustedRenderer: () => RendererLike | null,
  coordinator: SshBootstrapCoordinator
): void {
  ipcMain.handle('sshBootstrap:inspectTarget', async (event, ...args) => {
    assertTrustedRenderer(event, getTrustedRenderer)
    try {
      const target = parsedTarget(args[0])
      return target
        ? await coordinator.inspectTarget(target)
        : { status: 'rejected', errorCode: 'unexpected' }
    } catch {
      return { status: 'rejected', errorCode: 'unexpected' }
    }
  })
  ipcMain.handle('sshBootstrap:confirmHostKey', async (event, ...args) => {
    assertTrustedRenderer(event, getTrustedRenderer)
    try {
      return validId(args[0])
        ? await coordinator.confirmHostKey(args[0])
        : { status: 'rejected', errorCode: 'unexpected' }
    } catch {
      return { status: 'rejected', errorCode: 'unexpected' }
    }
  })
  ipcMain.handle('sshBootstrap:verifyPassword', async (event, ...args) => {
    assertTrustedRenderer(event, getTrustedRenderer)
    const rawInput = args[1]
    const input = parsedPassword(rawInput)
    try {
      if (!validId(args[0]) || !input) {
        return { status: 'failed', errorCode: 'unexpected', retryable: false }
      }
      return await coordinator.verifyPassword(args[0], input)
    } catch {
      return { status: 'failed', errorCode: 'unexpected', retryable: false }
    } finally {
      if (input) input.password = ''
      clearCredentialValue(rawInput)
    }
  })
  ipcMain.handle('sshBootstrap:completeWithKeyProtection', async (event, ...args) => {
    assertTrustedRenderer(event, getTrustedRenderer)
    const rawInput = args[1]
    const input = parsedKeyProtection(rawInput)
    try {
      if (!validId(args[0]) || !input) {
        return { status: 'failed', errorCode: 'unexpected', retryable: false }
      }
      return await coordinator.completeWithKeyProtection(args[0], input)
    } catch {
      return { status: 'failed', errorCode: 'unexpected', retryable: false }
    } finally {
      if (input?.keyProtection === 'passphrase') input.passphrase = ''
      clearCredentialValue(rawInput)
    }
  })
  ipcMain.handle('sshBootstrap:saveConfig', async (event, ...args) => {
    assertTrustedRenderer(event, getTrustedRenderer)
    try {
      if (!validId(args[0])) throw new Error('invalid')
      return await coordinator.saveConfig(args[0])
    } catch {
      throw new Error('SSH 引导配置写入失败')
    }
  })
  ipcMain.handle('sshBootstrap:declineConfig', async (event, ...args) => {
    assertTrustedRenderer(event, getTrustedRenderer)
    try {
      if (!validId(args[0])) throw new Error('invalid')
      return await coordinator.declineConfig(args[0])
    } catch {
      throw new Error('SSH 引导操作失败')
    }
  })
  ipcMain.handle('sshBootstrap:cancel', async (event, ...args) => {
    assertTrustedRenderer(event, getTrustedRenderer)
    if (validId(args[0])) await coordinator.cancel(args[0]).catch(() => undefined)
  })
}
