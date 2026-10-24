export type SessionMode = 'auto' | 'ask' | 'plan' | 'plan_execute' | 'full'
export type WorkMode = 'auto' | 'direct' | 'plan' | 'plan_execute'
export type SessionPermissionMode = 'auto' | 'ask' | 'full'

export type SessionModeFields = {
  readonly workMode: WorkMode
  readonly permissionMode: SessionPermissionMode
}

export const SESSION_MODE_PRESETS: Readonly<Record<SessionMode, SessionModeFields>> = {
  auto: { workMode: 'auto', permissionMode: 'auto' },
  ask: { workMode: 'direct', permissionMode: 'ask' },
  plan: { workMode: 'plan', permissionMode: 'auto' },
  plan_execute: { workMode: 'plan_execute', permissionMode: 'auto' },
  full: { workMode: 'direct', permissionMode: 'full' }
}

export function fieldsFromMode(mode: SessionMode): SessionModeFields {
  return { ...SESSION_MODE_PRESETS[mode] }
}

export function modeFromFields(fields: {
  workMode?: WorkMode
  permissionMode: SessionPermissionMode
}): SessionMode {
  if (fields.workMode === 'plan' || fields.workMode === 'plan_execute') return fields.workMode
  if (fields.workMode === undefined || fields.workMode === 'direct') {
    if (fields.permissionMode === 'ask' || fields.permissionMode === 'full') {
      return fields.permissionMode
    }
  }
  return 'auto'
}
