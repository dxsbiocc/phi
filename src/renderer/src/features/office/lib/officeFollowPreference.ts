export const OFFICE_FOLLOW_AI_STORAGE_KEY = 'phi.office.followAi.v1'

export interface OfficeFollowPreferenceReader {
  getItem(key: string): string | null
}

export interface OfficeFollowPreferenceWriter {
  setItem(key: string, value: string): void
}

export function readOfficeFollowAiPreference(
  storage: OfficeFollowPreferenceReader | null | undefined
): boolean {
  if (!storage) return true
  try {
    const value = storage.getItem(OFFICE_FOLLOW_AI_STORAGE_KEY)
    return value === 'false' ? false : true
  } catch {
    return true
  }
}

export function writeOfficeFollowAiPreference(
  storage: OfficeFollowPreferenceWriter | null | undefined,
  enabled: boolean
): boolean {
  if (!storage) return false
  try {
    storage.setItem(OFFICE_FOLLOW_AI_STORAGE_KEY, String(enabled))
    return true
  } catch {
    return false
  }
}
