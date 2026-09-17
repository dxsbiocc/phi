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
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
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
}
