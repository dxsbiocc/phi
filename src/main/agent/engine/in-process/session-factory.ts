import { SessionManager } from '@oh-my-pi/pi-coding-agent'
import {
  createAgentSession as createLegacyAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  type DefaultResourceLoaderOptions,
  type ResourceDiagnostic
} from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import { isRecord, stringValue } from './common'

export function createAgentSession(
  options: Parameters<typeof createLegacyAgentSession>[0]
): ReturnType<typeof createLegacyAgentSession> {
  return createLegacyAgentSession(options)
}

export async function makeSessionManager(
  params: unknown,
  cwd: string,
  agentDir: string
): Promise<SessionManager> {
  if (!isRecord(params))
    return SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))
  const kind = stringValue(params.kind, 'persistent')
  if (kind === 'memory') return SessionManager.inMemory(cwd)
  if (kind === 'open') {
    const path = stringValue(params.path)
    if (!path) throw new Error('Missing session path')
    return SessionManager.open(path, undefined, undefined, { initialCwd: cwd })
  }
  return SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))
}

export {
  DefaultResourceLoader,
  SettingsManager,
  initializeExtensions as initializeAgentExtensions,
  type DefaultResourceLoaderOptions,
  type ResourceDiagnostic
}
