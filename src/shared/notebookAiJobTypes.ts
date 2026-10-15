import type { AnalysisNotebookGeneratedCell } from './notebookCodeGeneration'

export type NotebookAiGenerationJobState = 'running' | 'completed' | 'failed'

export type NotebookAiGenerationJobPhase =
  'preparing' | 'waiting' | 'generating' | 'repairing' | 'completed' | 'failed'

/** Only model-returned content and actual host lifecycle changes are recorded. */
export interface NotebookAiGenerationActivity {
  id: string
  kind: 'phase' | 'thinking' | 'text' | 'action'
  at: string
  updatedAt: string
  text: string
  label?: string
  status?: 'running' | 'completed' | 'failed'
}

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
  entries?: NotebookAiGenerationActivity[]
  completedAt?: string
  sourcePreview?: string
  previewCells?: AnalysisNotebookGeneratedCell[]
  cellCount?: number
  error?: string
}
