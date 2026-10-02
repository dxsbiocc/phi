export type SkillSourceCategory = 'bundled' | 'installed-package' | 'user' | 'project' | 'plugin'

export interface SkillSummary {
  id: string
  name: string
  description: string
  filePath: string
  source: string
  sourceId?: string
  scope: 'user' | 'project' | 'temporary'
  sourceCategory: SkillSourceCategory
  sourceCategoryLabel: string
  enabled: boolean
  globalEnabled: boolean
  globalOverride: boolean | null
  projectOverride: boolean | null
  core: boolean
  /** Compatibility alias for older renderer consumers. */
  disabled: boolean
}

export interface SkillContent {
  filePath: string
  content: string
}
