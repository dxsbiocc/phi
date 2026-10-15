import type { PermissionMode } from '../projects'

export function validatePermissionMode(mode: unknown): PermissionMode {
  if (mode !== 'ask' && mode !== 'auto' && mode !== 'full') throw new Error('权限模式无效')
  return mode
}

/** A delayed composer action must never change the conversation that replaced it. */
export function validateSessionPermissionModeUpdate(
  mode: unknown,
  target: unknown,
  current: { path: string | null; phiSessionId?: string; sessionGeneration: number }
): PermissionMode {
  const permissionMode = validatePermissionMode(mode)
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new Error('权限设置缺少会话目标')
  }
  const value = target as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) => !['sessionPath', 'phiSessionId', 'sessionGeneration'].includes(key)
    ) ||
    (value.sessionPath !== null && typeof value.sessionPath !== 'string') ||
    (value.phiSessionId !== null && typeof value.phiSessionId !== 'string') ||
    !Number.isSafeInteger(value.sessionGeneration) ||
    value.sessionPath !== current.path ||
    value.phiSessionId !== (current.phiSessionId ?? null) ||
    value.sessionGeneration !== current.sessionGeneration
  ) {
    throw new Error('会话已切换，请重新选择权限模式')
  }
  return permissionMode
}
