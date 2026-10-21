export type FileOpenConversationLayout = 'sidebar' | 'tab'
import type { UiLanguage } from './uiLanguage'
import type { ModelAvailabilitySettings } from './modelAvailabilityTypes'

export interface PhiAppSettings {
  uiLanguage: UiLanguage
  noProjectTaskFolder: string
  allowExternalFileRead: boolean
  preventSleepDuringRuns: boolean
  nextActionSuggestionsEnabled: boolean
  fileOpenConversationLayout: FileOpenConversationLayout
  modelAvailability?: ModelAvailabilitySettings
}

export type PhiAppSettingsPatch = {
  uiLanguage?: UiLanguage
  noProjectTaskFolder?: string
  allowExternalFileRead?: boolean
  preventSleepDuringRuns?: boolean
  nextActionSuggestionsEnabled?: boolean
  fileOpenConversationLayout?: FileOpenConversationLayout
}

export const DEFAULT_ALLOW_EXTERNAL_FILE_READ = false
export const DEFAULT_PREVENT_SLEEP_DURING_RUNS = false
export const DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED = true
export const DEFAULT_FILE_OPEN_CONVERSATION_LAYOUT: FileOpenConversationLayout = 'sidebar'
