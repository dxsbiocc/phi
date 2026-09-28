export type BackgroundAgentJob = {
  agentSessionId: string
  agentRunId: string
  sessionId: string
  sessionPath: string
  sessionTitle: string
  agentName: string
  task: string
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  background: boolean
  startedAt: string
  completedAt?: string
  lastStep?: string
  toolCalls?: number
  toolCallId?: string
}
