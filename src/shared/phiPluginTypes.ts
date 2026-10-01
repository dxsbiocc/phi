export interface PhiPluginListItem {
  id: string
  version: string
  title: string
  summary: string
  enabled: boolean
  source: 'bundled' | 'local'
  installedAt: string
  directory: string
}

export interface PhiPluginProblemView {
  level: 'error' | 'warning'
  path: string
  message: string
  /** Concise localized text suitable for displaying directly in the next-task UI. */
  displayMessage: string
}

export interface PhiPluginMutationResult {
  ok: boolean
  plugins: PhiPluginListItem[]
  problems: PhiPluginProblemView[]
}
