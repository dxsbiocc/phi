/** Phi owns this contract; no engine SDK values cross the application boundary. */
export interface DecisionModelSelection {
  providerId: string
  modelId: string
}

export type DecisionPurpose = 'task_routing' | 'evidence_review' | 'recovery'

export interface DecisionRequest {
  purpose: DecisionPurpose
  context: string
  question: string
  options: Array<{ id: string; description: string }>
}

export interface DecisionResult {
  choice: string
  source: 'native' | 'model'
  model: DecisionModelSelection
  /** Native distribution concentration (0–1) only; omitted for text model labels. */
  confidence?: number
  fallbackReason?: 'not_configured' | 'unavailable'
}

export interface DecisionModelOption extends DecisionModelSelection {
  name: string
  configured: boolean
}
