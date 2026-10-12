/** Per-project memory policy. Both switches default off; `learn` requires `enabled`. */
export interface ProjectMemorySettings {
  /** Summarize this project's past conversations locally and add the summary to new sessions. */
  enabled: boolean
  /** Let the agent record durable lessons with the `learn` tool. */
  learn: boolean
}

export const DEFAULT_PROJECT_MEMORY_SETTINGS: ProjectMemorySettings = {
  enabled: false,
  learn: false
}

export interface ProjectMemoryLesson {
  /** Zero-based position among the lessons in `learned.md`, newest first. */
  index: number
  text: string
}

export interface ProjectMemorySnapshot {
  projectId: string
  settings: ProjectMemorySettings
  /** Contents of `memory_summary.md`; empty until the first background summary finishes. */
  summary: string
  summaryUpdatedAt: string | null
  lessons: ProjectMemoryLesson[]
}

export function normalizeProjectMemorySettings(value: unknown): ProjectMemorySettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PROJECT_MEMORY_SETTINGS }
  const record = value as Record<string, unknown>
  const enabled = record.enabled === true
  return { enabled, learn: enabled && record.learn === true }
}
