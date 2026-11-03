import type { PlanSpec } from './planRunTypes'

export type MissingToolId =
  'nextflow' | 'java' | 'jupyter' | 'docker' | 'singularity' | 'apptainer' | 'podman'

export type MissingToolCandidateSource =
  'saved' | 'path' | 'conda' | 'micromamba' | 'phi' | 'common'

export type MissingToolPrompt = {
  runtimeSessionId: string
  tool: { id: MissingToolId; label: string }
  candidates: Array<{
    path: string
    source: MissingToolCandidateSource
    version?: string
  }>
  install?: {
    environment: string
    location: string
    packages: string[]
    approximateSize: string
  }
  /** Set when Phi asks again because the previously entered path did not pass validation. */
  rejectedPath?: { path: string; reason: MissingToolRejectReason }
}

export type MissingToolRejectReason =
  | 'path-must-be-absolute'
  | 'invalid-path'
  | 'not-executable'
  | 'host-check-failed'
  | 'no-version'
  | 'java-too-old'

export type MissingToolChoice =
  | { action: 'candidate'; path: string }
  | { action: 'path'; path: string }
  | { action: 'install' }
  | { action: 'cancel' }

export type AgentUserInteractionOption = {
  label: string
  description: string
  preview?: string
}

export type AgentUserInteractionQuestion = {
  question: string
  header: string
  options: AgentUserInteractionOption[]
  multiSelect?: boolean
}

export type AgentUserInteractionRequest = {
  requestId: string
  questions: AgentUserInteractionQuestion[]
  planReview?: { title: string; content: string; planFilePath: string; steps?: PlanSpec }
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
  missingTool?: MissingToolPrompt
}

export type AgentUserInteractionAnswer = {
  questionIndex: number
  question: string
  kind: 'option' | 'custom' | 'multi'
  answer: string | null
  selected?: string[]
  notes?: string
  preview?: string
}

export type AgentUserInteractionResponse = {
  requestId: string
  answers: AgentUserInteractionAnswer[]
  cancelled?: boolean
  globalNote?: string
  error?: string
  missingToolChoice?: MissingToolChoice
}
