import type { ModelSelection, PermissionMode, ThinkingLevel } from '../agent/projects'

export interface SessionPreferenceTable<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  has(key: string): boolean
  delete(key: string): boolean
}

function createPreferenceTable<T>(values: Map<string, T>): SessionPreferenceTable<T> {
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value)
    },
    has: (key) => values.has(key),
    delete: (key) => values.delete(key)
  }
}

export class SessionPreferences {
  private readonly sessionModelSelections = new Map<string, ModelSelection | null>()
  private readonly sessionThinkingLevels = new Map<string, ThinkingLevel>()
  private readonly sessionPermissionModes = new Map<string, PermissionMode>()

  readonly modelSelections = createPreferenceTable(this.sessionModelSelections)
  readonly thinkingLevels = createPreferenceTable(this.sessionThinkingLevels)
  readonly permissionModes = createPreferenceTable(this.sessionPermissionModes)
}
