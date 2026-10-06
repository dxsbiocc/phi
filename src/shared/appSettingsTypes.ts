export interface PhiAppSettings {
  noProjectTaskFolder: string
  preventSleepDuringRuns: boolean
  nextActionSuggestionsEnabled: boolean
  officeEnabled: boolean
}

export type PhiAppSettingsPatch = {
  noProjectTaskFolder?: string
  preventSleepDuringRuns?: boolean
  nextActionSuggestionsEnabled?: boolean
  officeEnabled?: boolean
}

export const DEFAULT_PREVENT_SLEEP_DURING_RUNS = false
export const DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED = true
export const DEFAULT_OFFICE_ENABLED = true
