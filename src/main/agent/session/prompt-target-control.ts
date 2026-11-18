import type { PermissionMode } from '../projects'
import { findPhiSessionById } from './session-store'
import { isPhiOnlySessionPath, phiSessionIdFromPath } from './sessions'

export type PromptTargetInput = {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration?: number
  suppressUserMessageEvent?: boolean
  retryUserMessageId?: string
  planMode?: boolean
  planExecute?: boolean
}

export interface PromptRunDestination {
  sessionKey: string
  snapshot: {
    path: string | undefined
    cwd: string
    permissionMode: PermissionMode
  }
}

export interface PromptTargetControlOptions {
  getCurrentDestination: () => PromptRunDestination
  identity: {
    createPhiSessionKey: (sessionId: string, cwd: string) => string
    createSessionKey: (path: string | undefined, cwd: string) => string
    linkPhiManagedSessionKey: (sessionKey: string, cwd: string, phiSessionId: string) => string
    resolveSessionKeyAlias: (sessionKey: string) => string
  }
  getSessionGeneration: (sessionKey: string) => number
  openRuntimeSessionManager: (path: string) => Promise<{ getCwd(): string }>
  resolveSessionPermissionMode: (
    sessionKey: string,
    snapshot: { path: string; cwd: string }
  ) => PermissionMode
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
    ...(record.planMode === true ? { planMode: true } : {}),
    ...(record.planExecute === true ? { planExecute: true } : {})
  }
}

function resolveSavedDestination(
  sessionId: string,
  options: PromptTargetControlOptions
): PromptRunDestination {
  const manifest = findPhiSessionById(sessionId)
  if (!manifest) throw new Error('会话不存在或已被删除')
  const { cwd, permissionMode } = manifest
  const key = options.identity.createPhiSessionKey(manifest.sessionId, cwd)
  options.identity.linkPhiManagedSessionKey(key, cwd, manifest.sessionId)
  return {
    sessionKey: options.identity.resolveSessionKeyAlias(key),
    snapshot: { path: undefined, cwd, permissionMode }
  }
}

async function resolveJournalDestination(
  path: string,
  options: PromptTargetControlOptions
): Promise<PromptRunDestination> {
  const cwd = (await options.openRuntimeSessionManager(path)).getCwd()
  const sessionKey = options.identity.resolveSessionKeyAlias(
    options.identity.createSessionKey(path, cwd)
  )
  const permissionMode = options.resolveSessionPermissionMode(sessionKey, { path, cwd })
  return { sessionKey, snapshot: { path, cwd, permissionMode } }
}

function assertCurrentDraft(
  target: PromptTargetInput,
  current: PromptRunDestination,
  options: PromptTargetControlOptions
): void {
  if (
    current.snapshot.path !== undefined ||
    current.snapshot.cwd !== target.cwd ||
    (typeof target.sessionGeneration === 'number' &&
      target.sessionGeneration !== options.getSessionGeneration(current.sessionKey))
  ) {
    throw new Error('当前会话已切换，请重新发送')
  }
}

/** Resolve which conversation receives the prompt independently of UI navigation. */
export function resolvePromptRunDestination(
  target: PromptTargetInput | null,
  options: PromptTargetControlOptions
): PromptRunDestination | Promise<PromptRunDestination> {
  const pathSessionId = target?.path ? phiSessionIdFromPath(target.path) : null
  if (pathSessionId && target?.phiSessionId && pathSessionId !== target.phiSessionId) {
    throw new Error('当前会话已切换，请重新发送')
  }
  const sessionId = target?.phiSessionId ?? pathSessionId
  if (sessionId) return resolveSavedDestination(sessionId, options)

  const current = options.getCurrentDestination()
  if (!target) {
    return isPhiOnlySessionPath(current.snapshot.path)
      ? { ...current, snapshot: { ...current.snapshot, path: undefined } }
      : current
  }
  if (target.path === null) {
    assertCurrentDraft(target, current, options)
    return current
  }
  if (target.path === current.snapshot.path) return current
  return resolveJournalDestination(target.path, options)
}
