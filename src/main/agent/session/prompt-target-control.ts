import type { PermissionMode } from '../projects'
import { findPhiSessionById } from './session-store'
import { phiOnlySessionPath, phiSessionIdFromPath } from './sessions'
import type { SessionLifecycle } from './session-lifecycle'
import type { CreateAgentSessionResult } from '../runtime/runtime-adapter'

export type PromptTargetInput = {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration?: number
  suppressUserMessageEvent?: boolean
  retryUserMessageId?: string
  planMode?: boolean
}

export interface PromptTargetControlOptions {
  state: {
    getCurrentSessionPath: () => string | undefined
    getCurrentCwd: () => string
    sessionPermissionModes: Pick<Map<string, PermissionMode>, 'set'>
  }
  identity: {
    createPhiSessionKey: (sessionId: string, cwd: string) => string
    createSessionKey: (path: string | undefined, cwd: string) => string
    linkPhiManagedSessionKey: (sessionKey: string, cwd: string, phiSessionId: string) => string
    setPhiSessionIdForKey: (sessionKey: string, sessionId: string) => void
    resolveSessionKeyAlias: (sessionKey: string) => string
  }
  lifecycle: {
    getLifecycleForKey: (sessionKey: string) => SessionLifecycle<CreateAgentSessionResult>
    getCurrentLifecycle: () => SessionLifecycle<CreateAgentSessionResult>
    disposeAndSwitchSession: (
      path: string,
      cwd: string,
      permissionMode: PermissionMode,
      options: { notify: false }
    ) => Promise<unknown>
    openRuntimeSessionManager: (path: string) => Promise<{ getCwd(): string }>
    resolveSessionPermissionMode: (
      sessionKey: string,
      snapshot: { path: string; cwd: string }
    ) => PermissionMode
  }
}

export function parsePromptTarget(
  input: unknown,
  getCurrentCwd: () => string
): PromptTargetInput | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const path = record.path === null ? null : typeof record.path === 'string' ? record.path : null
  const phiSessionId = typeof record.phiSessionId === 'string' ? record.phiSessionId : undefined
  const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : getCurrentCwd()
  return {
    path,
    ...(phiSessionId ? { phiSessionId } : {}),
    cwd,
    ...(typeof record.sessionGeneration === 'number'
      ? { sessionGeneration: record.sessionGeneration }
      : {}),
    ...(record.suppressUserMessageEvent === true ? { suppressUserMessageEvent: true } : {}),
    ...(typeof record.retryUserMessageId === 'string'
      ? { retryUserMessageId: record.retryUserMessageId }
      : {}),
    ...(record.planMode === true ? { planMode: true } : {})
  }
}

// eslint-disable-next-line complexity, max-lines-per-function -- Preserves the target-alignment branches verbatim.
export async function alignCurrentSessionToPromptTarget(
  input: unknown,
  options: PromptTargetControlOptions
): Promise<void> {
  const target = parsePromptTarget(input, options.state.getCurrentCwd)
  if (!target) return

  if (target.phiSessionId) {
    const manifest = findPhiSessionById(target.phiSessionId)
    if (!manifest) throw new Error('会话不存在或已被删除')
    const stablePath = phiOnlySessionPath(manifest.sessionId)
    const targetKey = options.identity.createPhiSessionKey(manifest.sessionId, manifest.cwd)
    options.identity.linkPhiManagedSessionKey(targetKey, manifest.cwd, manifest.sessionId)
    options.state.sessionPermissionModes.set(
      options.identity.resolveSessionKeyAlias(targetKey),
      manifest.permissionMode
    )
    const generationMatches =
      typeof target.sessionGeneration !== 'number' ||
      target.sessionGeneration === options.lifecycle.getLifecycleForKey(targetKey).currentGeneration
    if (
      options.state.getCurrentSessionPath() === stablePath &&
      options.state.getCurrentCwd() === manifest.cwd &&
      generationMatches
    ) {
      return
    }
    await options.lifecycle.disposeAndSwitchSession(
      stablePath,
      manifest.cwd,
      manifest.permissionMode,
      {
        notify: false
      }
    )
    return
  }

  if (target.path === null) {
    const generationMatches =
      typeof target.sessionGeneration !== 'number' ||
      target.sessionGeneration === options.lifecycle.getCurrentLifecycle().currentGeneration
    if (
      options.state.getCurrentSessionPath() === undefined &&
      options.state.getCurrentCwd() === target.cwd &&
      generationMatches
    )
      return
    throw new Error('当前会话已切换，请重新发送')
  }

  const phiOnlySessionId = phiSessionIdFromPath(target.path)
  if (phiOnlySessionId) {
    const manifest = findPhiSessionById(phiOnlySessionId)
    if (!manifest) throw new Error('会话不存在或已被删除')
    const targetKey = options.identity.createSessionKey(target.path, manifest.cwd)
    options.identity.setPhiSessionIdForKey(targetKey, phiOnlySessionId)
    options.state.sessionPermissionModes.set(
      options.identity.resolveSessionKeyAlias(targetKey),
      manifest.permissionMode
    )
    if (
      options.state.getCurrentSessionPath() !== target.path ||
      options.state.getCurrentCwd() !== manifest.cwd
    ) {
      await options.lifecycle.disposeAndSwitchSession(
        target.path,
        manifest.cwd,
        manifest.permissionMode,
        { notify: false }
      )
    }
    return
  }

  if (options.state.getCurrentSessionPath() === target.path) {
    return
  }

  const cwd = (await options.lifecycle.openRuntimeSessionManager(target.path)).getCwd()
  const targetKey = options.identity.createSessionKey(target.path, cwd)
  const permissionMode = options.lifecycle.resolveSessionPermissionMode(targetKey, {
    path: target.path,
    cwd
  })
  if (
    options.state.getCurrentSessionPath() !== target.path ||
    options.state.getCurrentCwd() !== cwd
  ) {
    await options.lifecycle.disposeAndSwitchSession(target.path, cwd, permissionMode, {
      notify: false
    })
  }
}
