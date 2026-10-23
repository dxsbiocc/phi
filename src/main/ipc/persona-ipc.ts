import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import {
  fallbackMarkdownFromDescription,
  getPersonaMarkdown,
  isOnboarded,
  setPersonaMarkdown,
  skipOnboarding
} from '../agent/persona-manager'

type RpcConfigurationTarget = {
  resolved: () => Promise<unknown>
  assertCurrent: () => void
}

export interface PersonaIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  appName: string
  lifecycle: {
    invalidateAgentSession: () => Promise<void>
    logUnexpectedError: (error: unknown) => void
  }
  generation: {
    generatePersonaMarkdown: (
      description: string,
      control?: { assertCurrent(): void }
    ) => Promise<string>
  }
  rpc: {
    getCurrentSessionKey: () => string
    resolveSessionKeyAlias: (key: string) => string
    getPhiSessionIdForKey: (key: string) => string | null | undefined
    findPhiSessionById: (sessionId: string) => {
      runtimeRef?: unknown
      projectLocation?: { kind: string }
    } | null
    captureSessionControlTarget: (key: string, sessionId: string) => RpcConfigurationTarget
  }
}

function resolveCurrentRpcConfigurationTarget(
  options: PersonaIpcOptions
): RpcConfigurationTarget | null {
  const key = options.rpc.resolveSessionKeyAlias(options.rpc.getCurrentSessionKey())
  const phiSessionId = options.rpc.getPhiSessionIdForKey(key)
  const manifest = phiSessionId ? options.rpc.findPhiSessionById(phiSessionId) : null
  if (!phiSessionId || !(manifest?.runtimeRef || manifest?.projectLocation?.kind === 'ssh'))
    return null
  return options.rpc.captureSessionControlTarget(key, phiSessionId)
}

export function registerPersonaIpc(options: PersonaIpcOptions): void {
  const { ipcMain } = options
  const APP_NAME = options.appName
  const invalidateAgentSession = options.lifecycle.invalidateAgentSession
  const logUnexpectedError = options.lifecycle.logUnexpectedError
  const generatePersonaMarkdown = options.generation.generatePersonaMarkdown
  const captureCurrentRpcConfigurationTarget = (): RpcConfigurationTarget | null =>
    resolveCurrentRpcConfigurationTarget(options)

  ipcMain.handle(IPC.persona.getAppName, async () => APP_NAME)
  ipcMain.handle(IPC.persona.isOnboarded, async () => isOnboarded())
  ipcMain.handle(IPC.persona.getMarkdown, async () => getPersonaMarkdown())
  ipcMain.handle(IPC.persona.setMarkdown, async (_, markdown: string) => {
    const target = captureCurrentRpcConfigurationTarget()
    if (target) await target.resolved()
    target?.assertCurrent()
    setPersonaMarkdown(markdown)
    await invalidateAgentSession()
    return getPersonaMarkdown()
  })
  ipcMain.handle(IPC.persona.skip, async () => {
    skipOnboarding()
  })
  ipcMain.handle(IPC.persona.completeOnboarding, async (_, description: string) => {
    const trimmedDescription = description.trim()
    if (!trimmedDescription) {
      skipOnboarding()
      return ''
    }

    const target = captureCurrentRpcConfigurationTarget()
    if (target) await target.resolved()
    target?.assertCurrent()
    let markdown: string
    try {
      markdown = await generatePersonaMarkdown(trimmedDescription, target ?? undefined)
    } catch (error) {
      target?.assertCurrent()
      logUnexpectedError(error)
      console.error('生成人设配置失败，回退为原始描述:', error)
      markdown = fallbackMarkdownFromDescription(trimmedDescription)
    }

    target?.assertCurrent()
    setPersonaMarkdown(markdown)
    await invalidateAgentSession()
    return markdown
  })
}
