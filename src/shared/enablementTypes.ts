export type EnablementItemKey = `skill:${string}` | `plugin:${string}`

export type EnablementScope = { type: 'global' } | { type: 'project'; projectCwd: string }

export interface EnablementSnapshot {
  version: 1
  global: Record<string, boolean>
  projectPath?: string
  project: Record<string, boolean>
}
