export type OfficeSaveState = 'saved' | 'editing' | 'unsaved' | 'saving' | 'failed'

export interface OfficeSaveStatus {
  readonly saveState: OfficeSaveState
  readonly lastSavedRevision: number
  readonly lastSavedAt?: string
  readonly savedDraftHash?: string
}

export interface PersistedOfficeSaveStatus {
  readonly saveState?: 'saved' | 'unsaved' | 'failed'
  readonly lastSavedRevision?: number
  readonly lastSavedAt?: string
  readonly savedDraftHash?: string
}

export function persistedOfficeSaveStatus(status: OfficeSaveStatus): PersistedOfficeSaveStatus {
  const saveState =
    status.saveState === 'editing' || status.saveState === 'saving'
      ? ('unsaved' as const)
      : status.saveState
  return {
    saveState,
    lastSavedRevision: status.lastSavedRevision,
    ...(status.lastSavedAt ? { lastSavedAt: status.lastSavedAt } : {}),
    ...(status.savedDraftHash ? { savedDraftHash: status.savedDraftHash } : {})
  }
}

export function restoreOfficeSaveStatus(input: {
  readonly contentRevision: number
  readonly needsSave: boolean
  readonly frozen?: boolean
  readonly persisted?: PersistedOfficeSaveStatus
}): OfficeSaveStatus {
  const lastSavedRevision = input.persisted?.lastSavedRevision ?? input.contentRevision
  const unsaved = input.needsSave || input.contentRevision > lastSavedRevision
  const saveState = input.frozen
    ? 'unsaved'
    : input.persisted?.saveState === 'failed'
      ? 'failed'
      : unsaved
        ? 'unsaved'
        : (input.persisted?.saveState ?? 'saved')
  return {
    saveState,
    lastSavedRevision,
    ...(input.persisted?.lastSavedAt ? { lastSavedAt: input.persisted.lastSavedAt } : {}),
    ...(input.persisted?.savedDraftHash ? { savedDraftHash: input.persisted.savedDraftHash } : {})
  }
}

export function markOfficeEditing(status: OfficeSaveStatus): OfficeSaveStatus {
  return { ...status, saveState: 'editing' }
}

export function markOfficeUnsaved(status: OfficeSaveStatus): OfficeSaveStatus {
  return { ...status, saveState: 'unsaved' }
}

export function markOfficeSaving(status: OfficeSaveStatus): OfficeSaveStatus {
  return { ...status, saveState: 'saving' }
}

export function markOfficeSaveFailed(status: OfficeSaveStatus): OfficeSaveStatus {
  return { ...status, saveState: 'failed' }
}

export function markOfficeSaved(
  status: OfficeSaveStatus,
  saved: { readonly revision: number; readonly savedAt: string; readonly sha256?: string }
): OfficeSaveStatus {
  return {
    ...status,
    saveState: 'saved',
    lastSavedRevision: saved.revision,
    lastSavedAt: saved.savedAt,
    ...(saved.sha256 ? { savedDraftHash: saved.sha256 } : {})
  }
}
