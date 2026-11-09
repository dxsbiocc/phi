export interface PhiPluginDependency {
  name: string
  version?: string
  kind: 'conda' | 'pip' | 'source' | 'other'
  note?: string
}

export interface PhiPluginDependencyManifest {
  dependencies: PhiPluginDependency[]
  yamlText?: string
  sourceFile?: string
  lookedFor: string[]
}

export interface PhiPluginCatalogEnvironment {
  id: string
  title: string
  description?: string
  sharedNote?: string
  usedBySkills: string[]
  usedByAgents: string[]
  channels: string[]
  dependencyManifest: PhiPluginDependencyManifest
}

export interface PhiPluginCatalogDetail {
  id: string
  title: string
  summary: string
  version: string
  source: string
  official: boolean
  agents: Array<{ name: string; description: string }>
  skills: Array<{ name: string; description: string }>
  scriptTools: Array<{
    name: string
    description: string
    approval?: 'read' | 'write'
    skillName?: string
  }>
  environments: PhiPluginCatalogEnvironment[]
}

/**
 * `not-found` means the official website has no such plugin (for example a local-only plugin).
 * `failed` means the request or its response could not be trusted, so retrying may help.
 */
export type PhiPluginCatalogDetailReason = 'not-found' | 'failed'

export type PhiPluginCatalogDetailResult =
  | { status: 'available'; detail: PhiPluginCatalogDetail }
  | { status: 'unavailable'; reason: PhiPluginCatalogDetailReason }
