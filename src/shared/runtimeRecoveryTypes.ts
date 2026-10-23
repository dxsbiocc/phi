/** Explicit desktop recovery actions. None of these requests grants prompt/job execution. */
export interface RuntimeRecoveryTarget {
  sessionId: string
  projectId: string
  sessionPath: string
  sessionGeneration: number
}
export interface RuntimeRecoveryModelSelection {
  providerId: string
  modelId: string
}
export type RuntimeRecoveryIssue =
  | 'disconnected'
  | 'model-unavailable'
  | 'journal-missing'
  | 'journal-invalid'
  | 'asset-missing'
  | 'binding-changed'
  | 'run-held'
  | 'unknown'
export interface RuntimeRecoverySummary {
  readonly content: string
  readonly provenance: {
    readonly kind: 'phi-timeline'
    readonly version: 1
    readonly sourceSessionId: string
    readonly projectId: string | null
    readonly throughEventId: string | null
    readonly eventCount: number
    readonly sha256: string
  }
}
export interface RuntimeRecoveryState {
  readonly target: RuntimeRecoveryTarget
  readonly phase: 'not-started' | 'connected' | 'recovery-required' | 'busy'
  readonly issue?: RuntimeRecoveryIssue
  readonly message: string
  readonly canResume: boolean
  readonly canContinueFromSummary?: boolean
  readonly savedModel?: RuntimeRecoveryModelSelection
  readonly summary?: RuntimeRecoverySummary
}
export interface RuntimeSummaryContinuation {
  readonly path: string
  readonly phiSessionId: string
  readonly projectId: string
  readonly sessionGeneration: number
  readonly sourceSessionId: string
  readonly connected: false
}
export interface RuntimeRecoveryApi {
  getRuntimeRecoveryState(target: RuntimeRecoveryTarget): Promise<RuntimeRecoveryState | null>
  resumeRuntimeSession(
    target: RuntimeRecoveryTarget,
    replacementModel?: RuntimeRecoveryModelSelection
  ): Promise<RuntimeRecoveryState | null>
  onSessionChanged?(
    callback: (session: {
      phiSessionId?: string
      projectId?: string
      sessionGeneration: number
    }) => void
  ): () => void
  continueRuntimeFromSummary(
    target: RuntimeRecoveryTarget,
    sha256: string
  ): Promise<RuntimeSummaryContinuation>
}
