export type FileOpenConversationLayout = 'sidebar' | 'tab'

export interface PhiAppSettings {
  noProjectTaskFolder: string
  allowExternalFileRead: boolean
  preventSleepDuringRuns: boolean
  nextActionSuggestionsEnabled: boolean
  fileOpenConversationLayout: FileOpenConversationLayout
}

export type PhiAppSettingsPatch = {
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
