export type BackgroundAgentJob = {
  agentSessionId: string
  agentRunId: string
  sessionId: string
  sessionPath: string
  sessionTitle: string
  agentName: string
  task: string
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'
  /** False for restart metadata, which has no live SDK handle. */
  canControl?: boolean
  historyAvailable?: boolean
  background: boolean
  startedAt: string
  completedAt?: string
  lastStep?: string
  toolCalls?: number
  toolCallId?: string
}

/** A bash command the runtime is running in the background of a live conversation. */
export type BackgroundShellJob = {
  agentSessionId: string
  jobId: string
  sessionId: string
  sessionPath: string
  sessionTitle: string
  command: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt?: string
  output?: string
}
