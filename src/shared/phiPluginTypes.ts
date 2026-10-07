export interface PhiPluginListItem {
  id: string
  version: string
  title: string
  summary: string
  enabled: boolean
  source: 'bundled' | 'local'
  installedAt: string
  directory: string
  agents: string[]
  skills: string[]
  scriptTools: string[]
  environments: Array<{
    name: string
    ref: string
  }>
  agentDetails?: PhiPluginAgentDetail[]
  skillDetails?: PhiPluginSkillDetail[]
  scriptToolDetails?: PhiPluginScriptToolDetail[]
  usedEnvironments?: PhiPluginUsedEnvironment[]
}

export interface PhiPluginAgentDetail {
  name: string
  description: string
}

export interface PhiPluginSkillDetail {
  name: string
  description: string
  enabled: boolean
  environmentRef?: string
  environmentWarning?: string
}

export interface PhiPluginScriptToolDetail {
  name: string
  description: string
  approval: 'read' | 'write' | 'execute'
  skillName: string
}

export interface PhiPluginUsedEnvironment {
  ref: string
  name: string
  description?: string
  scope: 'builtin' | 'private' | 'project' | 'skill'
  skillNames: string[]
  agentNames: string[]
  warnings?: string[]
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

export interface PhiPluginInstallPreview {
  ok: boolean
  path: string
  action?: 'install' | 'upgrade' | 'same-or-older'
  id?: string
  version?: string
  title?: string
  summary?: string
  installedVersion?: string
  problems: PhiPluginProblemView[]
}
