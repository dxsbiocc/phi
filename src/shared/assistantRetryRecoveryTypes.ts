/**
 * Persisted presentation state for an assistant error that an automatic retry superseded.
 *
 * This mirrors the payload the engine forwards from OMP through agent events. Renderer code must
 * not depend on engine SDK modules, so the application owns the shape it reads and replays here.
 */
export type AssistantRetryRecoveryKind = 'credential' | 'model' | 'wait' | 'plain'

export type AssistantRetryRecovery =
  | {
      kind: 'auto-retry'
      status: 'recovered'
      attempt: number
      recoveredAt: string
      recovery: AssistantRetryRecoveryKind
      note: string
      supersededBy?: {
        timestamp: number
        responseId?: string
        provider: string
        model: string
      }
    }
  | {
      kind: 'auto-retry'
      status: 'superseded'
      attempt: number
      recovery: AssistantRetryRecoveryKind
      note: string
    }
