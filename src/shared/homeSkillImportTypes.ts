export type HomeSkillSource = 'agents' | 'claude' | 'codex' | 'cursor'

export interface HomeSkillCandidate {
  source: HomeSkillSource
  id: string
  title: string
  summary: string
  installed: boolean
}

export interface HomeSkillSourceStatus {
  source: HomeSkillSource
  present: boolean
  count: number
}

export interface HomeSkillImportCandidatesResult {
  candidates: HomeSkillCandidate[]
  sources: HomeSkillSourceStatus[]
  installedIds: string[]
}

export interface HomeSkillImportSelection {
  source: HomeSkillSource
  id: string
}

export interface HomeSkillImportResult {
  imported: string[]
  skipped: string[]
  errors: Array<{ source: HomeSkillSource; id: string; message: string }>
}
