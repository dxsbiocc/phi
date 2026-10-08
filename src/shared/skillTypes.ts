export type SkillSourceCategory = 'bundled' | 'installed-package' | 'user' | 'project' | 'plugin'

export interface SkillSummary {
  icon?: ResourceIconRef
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
  /** Skill contract 1.1.0 `phi.deprecated`: still works, being replaced; the message names the replacement. */
  deprecated?: string
  /** Declared `phi.environment` reference from the skill file. */
  environment?: string
  /** Declared `metadata.version` from the skill file. */
  version?: string
}

export interface SkillContent {
  filePath: string
  content: string
}
import type { ResourceIconRef } from './resourceIconTypes'
