export type NotebookAiGenerationJobState = 'running' | 'completed' | 'failed'

export type NotebookAiGenerationJobPhase =
  'preparing' | 'waiting' | 'generating' | 'repairing' | 'completed' | 'failed'

/** Read-only progress for one independent Notebook AI generation attempt. */
export interface NotebookAiGenerationJob {
  id: string
  requestId: string
  projectCwd: string
  notebookPath: string
  notebookName: string
  model: string
  prompt: string
  state: NotebookAiGenerationJobState
  phase: NotebookAiGenerationJobPhase
  startedAt: string
  updatedAt: string
  completedAt?: string
  sourcePreview?: string
  cellCount?: number
  error?: string
}
