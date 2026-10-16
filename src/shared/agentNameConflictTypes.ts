export type AgentNameConflictChoice = 'rename_phi' | 'rename_other' | 'not_now'

export interface AgentNameConflictNotice {
  readonly id: string
  readonly sessionId: string
  readonly projectId: string
  readonly hostAlias: string
  readonly filePath: string
  readonly phiAgentName: string
  readonly requestedName: string
  readonly proposedPhiName: string
  readonly proposedOtherName: string
}

export interface AgentNameConflictResolutionRequest {
  readonly id: string
  readonly choice: AgentNameConflictChoice
}

export interface AgentNameConflictQueueState {
  readonly current: AgentNameConflictNotice | null
}
